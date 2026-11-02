import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getEncoding } from 'js-tiktoken';
import type { ContextCategory, ContextComponent, RequestContextAnalysis, RequestUsage } from '../shared/types.js';

type Json = Record<string, any>;
interface Estimate { tokens: number; sampled: boolean; }
interface Contribution extends Estimate { category: ContextCategory; partial: boolean; note?: string; }
interface History {
  parts: Contribution[];
  slots: Map<string, Contribution>;
  warnings: Set<string>;
  scope: 'visible-history' | 'since-compaction';
  incomplete: boolean;
}
interface Snapshot { components: ContextComponent[]; scope: History['scope']; warnings: string[]; }
interface CacheEntry {
  identity: string;
  size: number;
  mtime: number;
  prefix: string;
  end: number;
  anchor: string;
  analysis: RequestContextAnalysis;
}
interface Line { value: Json | null; start: number; end: number; }

const categories: ContextCategory[] = ['userMessages', 'projectInstructions', 'skills', 'toolDefinitions', 'toolOutputs', 'other'];
const labels: Record<ContextCategory, string> = {
  userMessages: '用户消息', projectInstructions: '用户与项目指令', skills: 'Skills',
  toolDefinitions: '工具定义', toolOutputs: '工具输出', other: '其他可见上下文',
};
const baseNotes: Record<ContextCategory, string> = {
  userMessages: '按已记录的用户文本估算，包含前面回合的可见消息。',
  projectInstructions: '仅统计日志明确标记的 AGENTS.md 或用户指令；未读取当前磁盘文件补推历史。',
  skills: '统计明确标记的技能目录或可确认单一来源的 SKILL.md 返回；混合工具输出不拆猜。',
  toolDefinitions: '按已记录的工具说明和 schema 文本估算；模型侧工具序列化和延迟加载状态可能不同。',
  toolOutputs: '仅统计输入边界前的可见工具返回；混合输出继续归工具输出，不按关键词拆分。',
  other: '包括可见基础与运行指令、历史助手消息、工具调用参数及其他可识别文本。',
};
const COMMON_WARNING = '这些是日志可见候选上下文的文本估算，不是请求原始快照；协议封装、指令替换、历史裁剪和服务端处理可能使其与实测输入不同。';
const SAMPLE_CAP = 32_768;
const resultCache = new Map<string, CacheEntry>();
const estimateCache = new Map<string, Estimate>();
const inflight = new Map<string, Promise<RequestContextAnalysis>>();
let encoder: ReturnType<typeof getEncoding> | null = null;
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

function trimCache<K, V>(cache: Map<K, V>, maximum: number): void {
  while (cache.size > maximum) cache.delete(cache.keys().next().value!);
}

function countText(text: string): Estimate {
  const key = hash(text);
  const known = estimateCache.get(key);
  if (known) { estimateCache.delete(key); estimateCache.set(key, known); return known; }
  encoder ??= getEncoding('o200k_base');
  let estimate: Estimate;
  if (text.length <= SAMPLE_CAP) {
    estimate = { tokens: encoder.encode(text, [], []).length, sampled: false };
  } else {
    // Three separated spans reduce the bias of sampling only a log prefix.
    const span = Math.floor(SAMPLE_CAP / 3);
    const samples = [text.slice(0, span), text.slice(Math.floor((text.length - span) / 2), Math.floor((text.length - span) / 2) + span), text.slice(-span)];
    const tokens = samples.reduce((sum, sample) => sum + encoder!.encode(sample, [], []).length, 0);
    estimate = { tokens: Math.round(tokens * text.length / (span * 3)), sampled: true };
  }
  estimateCache.set(key, estimate);
  trimCache(estimateCache, 4096);
  return estimate;
}

function addText(history: History, category: ContextCategory, raw: string, slot?: string, partial = false, note?: string): void {
  let removedMedia = false;
  const text = raw.replace(/data:(?:image|audio|video|application\/octet-stream)[^,\s]*;base64,[a-z0-9+/=\r\n]+/gi, () => { removedMedia = true; return ''; });
  if (removedMedia) { history.warnings.add('图像、音频或视频编码未按文本计数；多模态输入消耗无法由这些文本估算。'); partial = true; }
  if (!text) return;
  const estimate = countText(text);
  const contribution: Contribution = { category, ...estimate, partial, ...(note ? { note } : {}) };
  if (slot) {
    if (history.slots.has(slot)) history.warnings.add('动态指令或工具定义按同类来源的最新可见版本估算，旧版本是否仍作为历史输入无法确认。');
    history.slots.set(slot, contribution);
  } else history.parts.push(contribution);
}

function snapshot(history: History): Snapshot {
  const parts = [...history.parts, ...history.slots.values()];
  const components: ContextComponent[] = categories.map(id => {
    const group = parts.filter(part => part.category === id);
    // No visible tool result at a known boundary is an observable zero. Absence
    // of instructions/skills/schemas is not evidence that the model received none.
    const knownZero = id === 'toolOutputs' && !history.incomplete;
    if (!group.length && !knownZero) return { id, label: labels[id], tokens: null, status: 'unavailable', method: 'none', items: 0,
      note: '输入边界前未找到可确认的记录，无法统计；不代表实际为零。' };
    return {
      id, label: labels[id], tokens: group.reduce((sum, part) => sum + part.tokens, 0),
      status: history.incomplete || group.some(part => part.partial) ? 'partial' : 'estimated',
      method: group.some(part => part.sampled) ? 'sampled' : 'tokenized', items: group.length,
      note: !group.length ? '输入边界前没有可见工具返回；估算为 0，仅适用于日志可见部分。'
        : baseNotes[id] + (group.some(part => part.sampled) ? ' 超长单项使用首部、中部和尾部共约 32K 字符采样外推。' : '')
          + [...new Set(group.map(part => part.note).filter(Boolean))].join(' '),
    };
  });
  return { components, scope: history.scope, warnings: [COMMON_WARNING, ...history.warnings] };
}

function finish(requestId: string, inputTokens: number, state: Snapshot | null): RequestContextAnalysis {
  if (!state) return unavailable(requestId, inputTokens, '没有可识别的本次模型输出边界，无法可靠排除当前输出。');
  const estimatedTotalTokens = state.components.reduce((sum, component) => sum + (component.tokens ?? 0), 0);
  return {
    requestId, inputTokens, tokenizer: 'o200k_base', boundary: 'inferred', scope: state.scope, components: state.components,
    estimatedTotalTokens, unattributedTokens: inputTokens - estimatedTotalTokens, excessTokens: Math.max(0, estimatedTotalTokens - inputTokens),
    warnings: [...state.warnings,
      '估算未归一化。正差仅用于对账，不是可精确归属的隐藏 token 成本；超出实测时仍保留原估算。',
      'o200k_base 是文本近似分词器，不保证与当前模型的实际分词和消息封装一致。'],
  };
}

function unavailable(requestId: string, inputTokens: number, warning: string): RequestContextAnalysis {
  return { requestId, inputTokens, tokenizer: 'o200k_base', boundary: 'unavailable', scope: 'unavailable',
    components: categories.map(id => ({ id, label: labels[id], tokens: null, status: 'unavailable', method: 'none', items: 0, note: warning })),
    estimatedTotalTokens: null, unattributedTokens: null, excessTokens: 0, warnings: [warning] };
}

async function* lines(filePath: string, end: number): AsyncGenerator<Line> {
  let buffer: Buffer = Buffer.alloc(0);
  let offset = 0;
  if (end <= 0) return;
  for await (const chunk of createReadStream(filePath, { end: end - 1, highWaterMark: 64 * 1024 })) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : chunk as Buffer;
    let split = buffer.indexOf(10);
    while (split >= 0) {
      const raw = buffer.subarray(0, split).toString('utf8').replace(/^\uFEFF/, '');
      let value: Json | null = null;
      try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed; } catch { /* visible corruption is reported, never interpreted as input */ }
      yield { value, start: offset, end: offset + split + 1 };
      offset += split + 1;
      buffer = buffer.subarray(split + 1);
      split = buffer.indexOf(10);
    }
  }
  if (buffer.length) {
    let value: Json | null = null;
    try { const parsed = JSON.parse(buffer.toString('utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed; } catch { /* partial tail */ }
    yield { value, start: offset, end: offset + buffer.length };
  }
}

function textParts(content: unknown, history: History): { text: string; index: number }[] {
  if (typeof content === 'string') return [{ text: content, index: 0 }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part, index) => {
    if (typeof part === 'string') return [{ text: part, index }];
    if (!part || typeof part !== 'object') return [];
    if (/image|audio|video|file/.test(String(part.type || ''))) {
      history.incomplete = true;
      history.warnings.add('图像、音频、文件或其他非文本内容未计入文本估算，其实际输入消耗无法统计。');
      return [];
    }
    return typeof part.text === 'string' ? [{ text: part.text, index }] : [];
  });
}

function byKind(kind: string, provenance: Json | undefined): ContextCategory | null {
  if (kind === 'user.text' || provenance?.type === 'user') return 'userMessages';
  if (kind === 'agents_md.instructions' || /^(?:user|project)[._]instructions$/.test(kind) || provenance?.type === 'agents_md') return 'projectInstructions';
  if (/^(?:host_skills|cloud_skills|skills)\./.test(kind) || provenance?.type === 'skills') return 'skills';
  if (/^tools\./.test(kind)) return 'toolDefinitions';
  return null;
}

function isInputContext(text: string): boolean {
  return /^\s*(?:<environment_context>|<external_codex_apps_|# AGENTS\.md instructions|<INSTRUCTIONS>|<user_instructions>)/.test(text);
}

function classifyFallback(text: string, role: string): ContextCategory {
  if (/^\s*(?:# AGENTS\.md instructions|<INSTRUCTIONS>|<user_instructions>)/.test(text)) return 'projectInstructions';
  if (/^\s*<skills_instructions>/.test(text)) return 'skills';
  if (/^\s*<tools>/.test(text)) return 'toolDefinitions';
  return role === 'user' && !isInputContext(text) ? 'userMessages' : 'other';
}

function fallbackParts(text: string, role: string): { category: ContextCategory; text: string }[] {
  const tagged = /<(skills_instructions|tools|user_instructions|INSTRUCTIONS)>[\s\S]*?<\/\1>/g;
  const parts: { category: ContextCategory; text: string }[] = [];
  let cursor = 0;
  for (const match of text.matchAll(tagged)) {
    const position = match.index!;
    if (position > cursor) parts.push({ category: classifyFallback(text.slice(cursor, position), role), text: text.slice(cursor, position) });
    parts.push({ category: match[1] === 'skills_instructions' ? 'skills' : match[1] === 'tools' ? 'toolDefinitions' : 'projectInstructions', text: match[0] });
    cursor = position + match[0].length;
  }
  if (!parts.length && /^\s*# AGENTS\.md instructions/.test(text) && text.includes('<environment_context>')) {
    const at = text.indexOf('<environment_context>');
    return [{ category: 'projectInstructions', text: text.slice(0, at) }, { category: 'other', text: text.slice(at) }];
  }
  if (cursor < text.length) parts.push({ category: classifyFallback(text.slice(cursor), role), text: text.slice(cursor) });
  return parts.length ? parts : [{ category: classifyFallback(text, role), text }];
}

function sourceSlot(kind: string, category: ContextCategory, role: string): string | undefined {
  if (role === 'assistant' || category === 'userMessages') return undefined;
  if (kind === 'model.base_instructions' || kind === 'model.instructions') return 'model.instructions';
  return kind && kind !== 'unknown' ? `instruction:${kind}` : undefined;
}

function safeText(value: unknown, history: History): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return textParts(value, history).map(part => part.text).join('\n');
  if (!value || typeof value !== 'object') return '';
  return JSON.stringify(value, (key, item) => {
    if (key === 'encrypted_content' || /^(?:image_url|image_data|audio_data|video_data)$/.test(key)) {
      history.incomplete = true;
      history.warnings.add('加密推理或多模态编码未作为可见文本统计。');
      return undefined;
    }
    return item;
  });
}

async function sampleHash(filePath: string, end: number, tail: boolean): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(256, end));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, tail ? Math.max(0, end - buffer.length) : 0);
    return hash(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

async function analyze(filePath: string, request: RequestUsage): Promise<RequestContextAnalysis> {
  if (request.source !== 'record') return unavailable(request.id, request.usage.inputTokens, '该条用量来自累计快照差值，可能跨越多个缺失调用，无法定位单次请求的输入上下文。');
  const metadata = await stat(filePath);
  const identity = `${metadata.dev}:${metadata.ino}`;
  const prefix = await sampleHash(filePath, metadata.size, false);
  const key = `${filePath}\0${request.id}\0${request.usage.inputTokens}`;
  const known = resultCache.get(key);
  if (known && known.identity === identity && metadata.size >= known.end && known.prefix === prefix
    && (metadata.size === known.size && metadata.mtimeMs === known.mtime || metadata.size > known.size && await sampleHash(filePath, known.end, true) === known.anchor)) {
    resultCache.delete(key); resultCache.set(key, known);
    return known.analysis;
  }
  const history: History = { parts: [], slots: new Map(), warnings: new Set(), scope: 'visible-history', incomplete: false };
  let frozen: Snapshot | null = null;
  let ownMeta: Json | null = null;
  let ordinal = 0;
  let baseHash = '';
  const seenMessages = new Set<string>();
  const eventMessages = new Set<string>();
  const seenRecordIds = new Set<string>();
  const toolSources = new Map<string, string>();
  const processItem = (payload: Json, recordOffset: number, replacement = false, fromEvent = false) => {
    const itemType = payload.type;
    const generated = payload.role === 'assistant' || ['reasoning', 'function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'image_generation_call'].includes(itemType);
    if (generated && !replacement && !frozen) frozen = snapshot(history);
    if (itemType === 'message') {
      const role = String(payload.role || 'unknown');
      const parts = textParts(payload.content, history);
      const whole = parts.map(part => part.text).join('\n');
      const wholeHash = hash(whole);
      const messageKey = `${role}:${wholeHash}`;
      if (!fromEvent && eventMessages.has(messageKey)) return;
      // session_meta repeats these exact instructions as a response_item.
      if (baseHash && wholeHash === baseHash && role !== 'user' && history.slots.has('model.instructions')) return;
      const meta = payload.internal_chat_message_metadata_passthrough || {};
      const kinds: unknown[] = Array.isArray(meta.content_item_kinds) ? meta.content_item_kinds : [];
      const itemMetadata: Json[] = Array.isArray(meta.content_item_metadata) ? meta.content_item_metadata : [];
      for (const part of parts) {
        const kind = typeof kinds[part.index] === 'string' ? String(kinds[part.index]) : '';
        const explicit = byKind(kind, itemMetadata[part.index]?.provenance);
        const classified = role === 'assistant' ? [{ category: 'other' as ContextCategory, text: part.text }]
          : explicit ? [{ category: explicit, text: part.text }] : kind && kind !== 'unknown'
            ? [{ category: 'other' as ContextCategory, text: part.text }] : fallbackParts(part.text, role);
        for (const piece of classified) addText(history, piece.category, piece.text, sourceSlot(kind, piece.category, role), piece.category === 'toolDefinitions',
          piece.category === 'toolDefinitions' && /^tools\./.test(kind) ? ' 此项含工具说明，完整模型侧 schema 加载情况无法确认。' : undefined);
      }
      if (whole) {
        seenMessages.add(messageKey);
        if (fromEvent) eventMessages.add(messageKey);
      }
    } else if (['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'image_generation_call'].includes(itemType)) {
      const argumentsText = safeText(payload.arguments ?? payload.input ?? payload.action, history);
      const name = String(payload.name || itemType);
      addText(history, 'other', `${name}\n${argumentsText}`);
      // Only a dedicated single-file reader provides enough evidence to move a
      // SKILL.md result out of the tool-output category. Shell/exec scripts do not.
      if (/(?:^|[._])(?:read_file|read_text_file|readfile)$/.test(name)) {
        try {
          const args = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments;
          const source = args?.path ?? args?.file_path;
          if (typeof source === 'string' && /(?:^|[\\/])SKILL\.md$/i.test(source)) toolSources.set(String(payload.call_id || payload.id), source);
        } catch { /* mixed or unstructured call arguments cannot prove source */ }
      }
    } else if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(itemType)) {
      const callId = String(payload.call_id || payload.id);
      const output = safeText(payload.output, history);
      const skillSource = toolSources.get(callId);
      addText(history, skillSource ? 'skills' : 'toolOutputs', output, skillSource ? `loaded-skill:${skillSource}` : undefined,
        false, skillSource ? ' 已由专用单文件读取调用确认来源为 SKILL.md。' : undefined);
    } else if (itemType === 'additional_tools') {
      const schemas = Array.isArray(payload.tools) ? payload.tools : [];
      schemas.forEach((schema: Json, index: number) => {
        const name = String(schema.name || schema.function?.name || `anonymous-${recordOffset}-${index}`);
        addText(history, 'toolDefinitions', safeText(schema, history), `schema:${name}`);
      });
    } else if (itemType === 'reasoning') {
      const summary = safeText(payload.summary ?? [], history);
      if (summary) addText(history, 'other', summary, undefined, true, ' 仅有可见推理摘要，未计加密或未记录的推理内容。');
      if (payload.encrypted_content) history.warnings.add('加密推理编码未按普通文本计数，后续请求是否保留了这些内容无法由日志确定。');
    } else if (itemType === 'agent_message') {
      addText(history, 'other', safeText(payload.content, history));
    }
  };

  for await (const line of lines(filePath, metadata.size)) {
    if (!line.value) { history.incomplete = true; history.warnings.add('输入边界前存在损坏或未完成的日志记录，可见候选上下文不完整。'); continue; }
    const raw = line.value;
    const type = String(raw.type || (raw.payload ? 'session_meta' : 'unknown'));
    const payload: Json = raw.payload && typeof raw.payload === 'object' ? raw.payload : raw;
    const itemOrdinal = typeof raw.ordinal === 'number' ? raw.ordinal : ordinal;
    ordinal++;
    if (type === 'session_meta' || type === 'session_meta_root') {
      if (!ownMeta) {
        ownMeta = payload;
        const base = typeof payload.base_instructions === 'string' ? payload.base_instructions : payload.base_instructions?.text;
        if (typeof base === 'string' && base) { baseHash = hash(base); addText(history, 'other', base, 'model.instructions'); }
        if (typeof payload.subagent_history_start_ordinal === 'number' && payload.subagent_history_start_ordinal > itemOrdinal + 1) {
          history.incomplete = true;
          history.warnings.add('此子会话包含继承历史；继承重放已排除，模型实际携带的继承上下文无法完整还原。');
        }
      }
      continue;
    }
    if (typeof ownMeta?.subagent_history_start_ordinal === 'number' && itemOrdinal < ownMeta.subagent_history_start_ordinal) continue;
    if (type === 'world_state') continue;
    if (type === 'retained_context') {
      history.warnings.add('日志包含 retained_context 保留答案状态，其实际注入形式未知；没有将其直接计为新输入或清空历史。');
      continue;
    }
    if (type === 'compacted') {
      history.parts = [];
      history.slots.clear();
      history.scope = 'since-compaction';
      history.incomplete = true;
      frozen = null;
      seenMessages.clear();
      eventMessages.clear();
      history.warnings.add('此前发生上下文压缩；旧可见历史已清除，仅估算压缩后明确记录的内容，无法重建完整输入。');
      if (typeof payload.message === 'string') addText(history, 'other', payload.message, undefined, true, ' 日志记录的压缩摘要。');
      const replacement = payload.replacement_history ?? raw.replacement_history;
      if (Array.isArray(replacement)) replacement.forEach(item => {
        if (item && typeof item === 'object') processItem(item.payload && typeof item.payload === 'object' ? item.payload : item, line.start, true);
      });
      continue;
    }
    if (type === 'token_usage_record') {
      const id = String(payload.response_id || '');
      if (!id || seenRecordIds.has(id)) continue;
      seenRecordIds.add(id);
      const input = typeof payload.usage?.input_tokens === 'number' ? payload.usage.input_tokens : id === request.id ? request.usage.inputTokens : 0;
      const analysis = finish(id, input, frozen);
      const analysisKey = `${filePath}\0${id}\0${input}`;
      resultCache.set(analysisKey, { identity, size: metadata.size, mtime: metadata.mtimeMs, prefix, end: line.end,
        anchor: await sampleHash(filePath, line.end, true), analysis });
      trimCache(resultCache, 256);
      frozen = null;
      if (id === request.id) return analysis;
      continue;
    }
    if (type === 'response_item') { processItem(payload, line.start); continue; }
    if (type === 'event_msg' && payload.type === 'task_started') {
      seenMessages.clear();
      eventMessages.clear();
    }
    if (['message', 'function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'reasoning'].includes(type)) {
      processItem({ ...payload, type }, line.start); continue;
    }
    if (type === 'event_msg' && ['user_message', 'agent_message', 'agent_reasoning'].includes(payload.type)) {
      const role = payload.type === 'user_message' ? 'user' : 'assistant';
      const text = typeof payload.message === 'string' ? payload.message : typeof payload.text === 'string' ? payload.text : '';
      if (text && !seenMessages.has(`${role}:${hash(text)}`)) {
        processItem({ type: 'message', role, content: [{ type: 'text', text }] }, line.start, false, true);
      }
    }
  }
  throw new Error('未找到该次模型调用的用量记录，日志可能已经变更。');
}

export async function analyzeRequestContext(filePath: string, request: RequestUsage): Promise<RequestContextAnalysis> {
  const resolved = path.resolve(filePath);
  const key = `${resolved}\0${request.id}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = analyze(resolved, request);
  inflight.set(key, task);
  try { return await task; } finally { inflight.delete(key); }
}
