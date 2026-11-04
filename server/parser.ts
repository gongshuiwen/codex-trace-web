import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IndexedSession } from './parser-types.js';
import type { CollaborationMessage, CompactionPage, OutputPage, RequestUsage, SessionActivity, SessionSummary, TimelineEvent, ToolCall, ToolFailurePage, TurnDetail, TurnSummary } from '../shared/types.js';
import { UsageLedger } from './usage.js';
import { parseCollaborationMessage } from './collaboration.js';

type Json = Record<string, any>;
interface Line { start: number; end: number; value: Json | null; partial?: boolean; }
interface MutableTurn {
  summary: TurnSummary;
  callIds: Set<string>;
  toolStatuses: Map<string, ToolCall['status']>;
  failureCount: number;
  messages: Map<string, { kind: string; text: string }>;
  hasEventPrompt: boolean;
}
interface CachedIndex {
  fingerprint: string;
  identity: string;
  prefix: string;
  anchor: string;
  scanOffset: number;
  meta: Json;
  turns: Map<string, MutableTurn>;
  currentTurnId: string;
  counter: number;
  ledger: UsageLedger;
  outputs: Map<string, { start: number; end: number }>;
  parseErrors: number;
  partialTail: boolean;
  model: string;
  ended: boolean;
  hasTaskStarted: boolean;
  entryOrdinal: number;
  compactions: { id: string; turnId?: string; navigationTurnId?: string; timestamp: string; offset: number }[];
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  activityMessages: SessionActivity['messages'];
  agentPath?: string;
  index: IndexedSession | null;
}

const cache = new Map<string, CachedIndex>();
const pending = new Map<string, Promise<CachedIndex>>();
const MAX_CACHED_FILES = 24;
const PREVIEW_LENGTH = 280;
const DEFAULT_OUTPUT_LIMIT = 16_384;
const MAX_PAGE_LIMIT = 65_536;
const ignoredEvents = new Set(['token_count', 'item_completed', 'thread_settings_applied', 'rate_limits', 'task_started', 'task_complete', 'turn_aborted', 'agent_message', 'agent_reasoning', 'user_message']);
const ignoredTop = new Set(['token_usage_record', 'world_state', 'inter_agent_communication_metadata', 'session_end']);

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value, null, 2);
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return stringify(value);
  return value.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text
    : part?.type === 'image' || part?.type === 'input_image' || part?.type === 'image_url' ? '[图像]' : '').filter(Boolean).join('\n');
}

function messageText(payload: Json): string {
  return contentText(payload.content ?? payload.message ?? payload.text ?? '');
}

function recordedName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parentSessionId(meta: Json): string | undefined {
  return [meta.parent_session_id, meta.parent_thread_id, meta.source?.subagent?.thread_spawn?.parent_thread_id,
    meta.source?.subagent?.parent_thread_id, meta.thread_source?.parent_thread_id].map(recordedName).find(Boolean);
}

function isInjected(text: string): boolean {
  return /^(?:\s*<environment_context>|\s*<external_codex_apps_open_page>|\s*<user_instructions>|\s*<permissions instructions>|\s*# AGENTS\.md instructions|\s*<INSTRUCTIONS>)/i.test(text);
}

function timestampOf(value: Json): string {
  const raw = value.timestamp;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return new Date(raw < 1e12 ? raw * 1000 : raw).toISOString();
  return '';
}

function epochTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

async function* readLines(filePath: string, start = 0, end?: number): AsyncGenerator<Line> {
  if (end != null && end <= start) return;
  const stream = createReadStream(filePath, { start, ...(end != null ? { end: end - 1 } : {}), highWaterMark: 64 * 1024 });
  let buffer: Buffer = Buffer.alloc(0);
  let offset = start;
  for await (const chunk of stream) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : chunk as Buffer;
    let newline = buffer.indexOf(10);
    while (newline >= 0) {
      const bytes = buffer.subarray(0, newline);
      const next = offset + newline + 1;
      const line = bytes.toString('utf8').replace(/\r$/, '').replace(/^\uFEFF/, '');
      let value: Json | null = null;
      if (line.trim()) { try { const parsed = JSON.parse(line); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed; } catch { /* skip malformed complete lines */ } }
      yield { start: offset, end: next, value: line.trim() ? value : {} };
      offset = next;
      buffer = buffer.subarray(newline + 1);
      newline = buffer.indexOf(10);
    }
  }
  if (buffer.length) {
    const line = buffer.toString('utf8').replace(/\r$/, '');
    try {
      const value = JSON.parse(line);
      yield { start: offset, end: offset + buffer.length, value: value && typeof value === 'object' && !Array.isArray(value) ? value : null };
    } catch {
      yield { start: offset, end: offset + buffer.length, value: null, partial: true };
    }
  }
}

function emptyState(): CachedIndex {
  return { fingerprint: '', identity: '', prefix: '', anchor: '', scanOffset: 0, meta: {}, turns: new Map(), currentTurnId: '', counter: 0,
    ledger: new UsageLedger(), outputs: new Map(), parseErrors: 0, partialTail: false, model: '', ended: false, hasTaskStarted: false, entryOrdinal: 0,
    compactions: [], firstTimestamp: null, lastTimestamp: null, activityMessages: [], index: null };
}

function recordTimestamp(state: CachedIndex, timestamp: string): void {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return;
  state.firstTimestamp = Math.min(state.firstTimestamp ?? value, value);
  state.lastTimestamp = Math.max(state.lastTimestamp ?? value, value);
}

function ensureTurn(state: CachedIndex, id: string, timestamp: string, offset: number): MutableTurn {
  let turn = state.turns.get(id);
  if (!turn) {
    turn = { summary: { id, index: state.turns.size, prompt: '', preview: '', startedAt: timestamp, status: 'running', model: state.model,
      toolCount: 0, toolFailureCount: 0, compactionCount: 0, usage: state.ledger.summary(id), startOffset: offset, endOffset: offset },
      callIds: new Set(), toolStatuses: new Map(), failureCount: 0, messages: new Map(), hasEventPrompt: false };
    state.turns.set(id, turn);
  }
  state.currentTurnId = id;
  return turn;
}

function currentTurn(state: CachedIndex, payload: Json, timestamp: string, offset: number): MutableTurn {
  const explicit = typeof payload.turn_id === 'string' ? payload.turn_id : '';
  return ensureTurn(state, explicit || state.currentTurnId || `turn-${++state.counter}`, timestamp, offset);
}

function classifyMessage(type: string, payload: Json): { kind: string; text: string; eventPrompt: boolean; collaboration?: CollaborationMessage } | null {
  if (type === 'event_msg') {
    if (payload.type === 'user_message') return { kind: 'user', text: messageText(payload), eventPrompt: true };
    if (payload.type === 'agent_message') return { kind: payload.phase === 'commentary' ? 'commentary' : 'assistant', text: messageText(payload), eventPrompt: false };
    if (payload.type === 'agent_reasoning') return { kind: 'reasoning', text: messageText(payload), eventPrompt: false };
  }
  const itemType = type === 'response_item' ? payload.type : type;
  if (itemType === 'message') {
    const text = messageText(payload);
    const role = payload.role;
    return { kind: role === 'developer' || role === 'system' || (role === 'user' && isInjected(text)) ? 'context'
      : role === 'user' ? 'user' : payload.phase === 'commentary' || payload.channel === 'commentary' ? 'commentary' : 'assistant', text, eventPrompt: false };
  }
  if (itemType === 'reasoning') return { kind: 'reasoning', text: contentText(payload.summary ?? []), eventPrompt: false };
  if (itemType === 'agent_message') {
    const text = contentText(payload.content);
    const collaboration = parseCollaborationMessage(text);
    return { kind: collaboration ? 'collaboration' : 'notice', text, eventPrompt: false, ...(collaboration ? { collaboration } : {}) };
  }
  return null;
}

function detectType(value: Json): string {
  if (typeof value.type === 'string') return value.type;
  if (value.payload) return 'session_meta';
  if (value.id && value.timestamp) return 'session_meta_root';
  if (value.call_id && value.name) return 'function_call';
  if (value.call_id && value.output != null) return 'function_call_output';
  if (value.role && value.content) return 'message';
  return 'unknown';
}

function normalizedPayload(value: Json, type: string): Json {
  return value.payload && typeof value.payload === 'object' ? value.payload : type === 'session_meta_root' || !value.payload ? value : {};
}

function toolShape(type: string, payload: Json): 'call' | 'output' | null {
  const itemType = type === 'response_item' ? payload.type : type;
  if (['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'].includes(itemType)) return 'call';
  if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(itemType)) return 'output';
  return null;
}

function processLine(state: CachedIndex, line: Line): void {
  const value = line.value;
  if (!value) { if (line.partial) state.partialTail = true; else state.parseErrors++; return; }
  if (!Object.keys(value).length) return;
  const type = detectType(value);
  const payload = normalizedPayload(value, type);
  const timestamp = timestampOf(value);
  const ordinal = typeof value.ordinal === 'number' ? value.ordinal : state.entryOrdinal;
  state.entryOrdinal++;
  if (type === 'session_meta' || type === 'session_meta_root') {
    // A child rollout starts with its own metadata, then may replay the parent's
    // session_meta and transcript. Only the first metadata describes this file.
    // Replacing it with inherited metadata makes a child overwrite the parent's
    // SQLite index row and sends detail requests to an entirely different file.
    if (!Object.keys(state.meta).length) {
      state.meta = { ...payload };
      recordTimestamp(state, timestamp || epochTimestamp(payload.timestamp, ''));
    }
    return;
  }
  const historyStart = state.meta.subagent_history_start_ordinal;
  if (typeof historyStart === 'number' && ordinal < historyStart) return;
  recordTimestamp(state, timestamp);
  let compaction: CachedIndex['compactions'][number] | undefined;
  if (type === 'compacted') {
    const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : state.currentTurnId;
    compaction = { id: `notice-${line.start}`, timestamp, offset: line.start, ...(turnId ? { turnId } : {}) };
    state.compactions.push(compaction);
  }
  if (type === 'session_end') { state.ended = true; return; }
  if (type === 'event_msg' && payload.type === 'task_started') {
    state.hasTaskStarted = true;
    const id = String(payload.turn_id || `turn-${++state.counter}`);
    const turn = ensureTurn(state, id, epochTimestamp(payload.started_at ?? payload.turn_start_timestamp, timestamp), line.start);
    turn.summary.status = 'running';
    state.ended = false;
    state.ledger.setContextWindow(id, payload.model_context_window);
  }
  const classified = classifyMessage(type, payload);
  const current = state.turns.get(state.currentTurnId);
  if (classified?.kind === 'user' && !isInjected(classified.text) && !state.hasTaskStarted && current?.summary.prompt
    && !current.messages.has(`user:${classified.text}`) && (classified.eventPrompt || current.callIds.size > 0 || current.summary.preview)) {
    current.summary.status = 'completed';
    current.summary.endedAt = timestamp;
    current.summary.endOffset = line.start;
    ensureTurn(state, `turn-${++state.counter}`, timestamp, line.start);
  }
  const active = state.turns.get(state.currentTurnId);
  if (classified?.kind === 'user' && !payload.turn_id && (!active || (active.summary.status !== 'running' && !active.messages.has(`user:${classified.text}`)))) {
    ensureTurn(state, `turn-${++state.counter}`, timestamp, line.start);
  }
  if (!state.currentTurnId && !classified && type !== 'turn_context' && type !== 'compacted' && !toolShape(type, payload)
    && !(type === 'token_usage_record' && typeof payload.turn_id === 'string')) return;
  const turn = currentTurn(state, payload, timestamp, line.start);
  turn.summary.endOffset = line.end;
  if (compaction) {
    compaction.navigationTurnId = turn.summary.id;
    turn.summary.compactionCount = (turn.summary.compactionCount ?? 0) + 1;
  }
  if (classified?.collaboration) {
    const collaboration = classified.collaboration;
    if (!state.agentPath && parentSessionId(state.meta) && collaboration.messageType === 'NEW_TASK') state.agentPath = collaboration.taskName;
    const preview = collaboration.payload.length > 200 ? `${collaboration.payload.slice(0, 199).replace(/[\uD800-\uDBFF]$/, '')}…` : collaboration.payload;
    state.activityMessages.push({ id: `event-${line.start}`, turnId: turn.summary.id, timestamp,
      messageType: collaboration.messageType, sender: collaboration.sender, taskName: collaboration.taskName, preview });
  }
  if (type === 'turn_context') {
    state.model = typeof payload.model === 'string' ? payload.model : state.model;
    turn.summary.model = state.model;
    state.meta.cwd ??= payload.cwd;
    state.ledger.setContextWindow(turn.summary.id, payload.model_context_window);
  }
  state.ledger.ingest(type, payload, turn.summary.id, timestamp, line.start, turn.summary.model || state.model);
  if (type === 'event_msg') {
    if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
      turn.summary.status = payload.type === 'turn_aborted' || payload.error ? 'interrupted' : 'completed';
      turn.summary.endedAt = epochTimestamp(payload.completed_at, timestamp);
      if (!turn.summary.preview && typeof payload.last_agent_message === 'string') turn.summary.preview = payload.last_agent_message.slice(0, PREVIEW_LENGTH);
    }
    if (payload.type === 'thread_name_updated') state.meta.thread_name = payload.thread_name ?? payload.name;
  }
  if (classified && classified.text) {
    let kind = classified.kind;
    if (kind === 'user' && isInjected(classified.text)) kind = 'context';
    if (kind !== 'context') {
      if (kind !== 'collaboration') turn.messages.set(`${kind}:${classified.text}`, { kind, text: classified.text });
      if (kind === 'user' && (!turn.summary.prompt || (classified.eventPrompt && !turn.hasEventPrompt))) {
        turn.summary.prompt = classified.text.slice(0, 1000);
      }
      if (kind === 'user') turn.hasEventPrompt ||= classified.eventPrompt;
      if (kind === 'assistant') turn.summary.preview = classified.text.slice(0, PREVIEW_LENGTH);
    }
  }
  const shape = toolShape(type, payload);
  if (shape) {
    const id = String(payload.call_id ?? payload.id ?? `tool-${line.start}`);
    // Output-only records are displayed as unknown tools in detail, so count their identities too.
    turn.callIds.add(id);
    turn.summary.toolCount = turn.callIds.size;
    if (shape === 'call') {
      if (!turn.toolStatuses.has(id)) turn.toolStatuses.set(id, payload.status === 'completed' ? 'completed' : 'running');
    } else {
      const status = inferOutput(payload, contentText(payload.output)).status;
      if (turn.toolStatuses.get(id) === 'failed') turn.failureCount--;
      if (status === 'failed') turn.failureCount++;
      turn.toolStatuses.set(id, status);
      turn.summary.toolFailureCount = turn.failureCount;
      state.outputs.set(id, { start: line.start, end: line.end });
    }
  }
}

async function fileSample(filePath: string, length: number, start = 0): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(length, 256));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
  } finally { await handle.close(); }
}

function buildIndex(state: CachedIndex, filePath: string, fileSize: number, updatedAt: string, revision: string): IndexedSession {
  const meta = state.meta;
  const turns = [...state.turns.values()].map(turn => {
    let status = turn.summary.status;
    if (status === 'running' && (state.ended || Date.now() - Date.parse(updatedAt) > 60_000)) status = 'interrupted';
    return { ...turn.summary, status, toolFailureCount: turn.failureCount,
      usage: state.ledger.summary(turn.summary.id), model: turn.summary.model || state.model };
  });
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
  const id = String(meta.id ?? meta.session_id ?? meta.thread?.sessionId ?? path.basename(filePath).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0]
    ?? createHash('sha256').update(filePath).digest('hex').slice(0, 24));
  const firstPrompt = turns.find(turn => turn.prompt)?.prompt;
  const project = cwd ? cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd : '未知项目';
  const parentId = parentSessionId(meta);
  const spawn = meta.source?.subagent?.thread_spawn;
  const agentNickname = parentId ? recordedName(meta.agent_nickname) || recordedName(spawn?.agent_nickname) : undefined;
  const agentName = parentId ? recordedName(meta.agent_path) || recordedName(spawn?.agent_path) || state.agentPath || agentNickname : undefined;
  const session: SessionSummary = {
    id, title: String(meta.thread_name ?? meta['ai-title'] ?? meta.title ?? firstPrompt?.slice(0, 100) ?? project), cwd, project,
    model: turns.at(-1)?.model || state.model || '未知模型', branch: meta.git?.branch,
    source: typeof meta.originator === 'string' ? meta.originator : typeof meta.source === 'string' ? meta.source : meta.source?.subagent ? '子代理' : 'Codex',
    startedAt: epochTimestamp(meta.timestamp, turns[0]?.startedAt || updatedAt), updatedAt,
    status: turns.at(-1)?.status ?? 'unknown', turnCount: turns.length,
    toolCount: turns.reduce((count, turn) => count + turn.toolCount, 0),
    toolFailureCount: turns.reduce((count, turn) => count + turn.toolFailureCount, 0),
    durationMs: state.firstTimestamp == null || state.lastTimestamp == null ? null : state.lastTimestamp - state.firstTimestamp,
    compactionCount: state.compactions.length,
    ...(typeof parentId === 'string' ? { parentId } : {}), filePath, fileSize, revision,
    ...(agentName ? { agentName } : {}), ...(agentNickname ? { agentNickname } : {}),
    usage: state.ledger.summary(), parseErrors: state.parseErrors,
  };
  const searchMessages = [...state.turns.values()].flatMap(turn => [...turn.messages.values()]
    .filter(message => ['user', 'assistant', 'commentary'].includes(message.kind))
    .map(message => ({ turnId: turn.summary.id, text: message.text })));
  return { session, turns, searchMessages };
}

async function readIndex(filePath: string): Promise<CachedIndex> {
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error('会话路径不是文件');
  const fingerprint = `${metadata.size}:${metadata.mtimeMs}`;
  const existing = cache.get(filePath);
  if (existing?.fingerprint === fingerprint && existing.index) {
    cache.delete(filePath); cache.set(filePath, existing);
    // Freshness of the running indicator changes even when the file does not.
    existing.index = buildIndex(existing, filePath, metadata.size, metadata.mtime.toISOString(), fingerprint);
    return existing;
  }
  const identity = `${metadata.dev}:${metadata.ino}`;
  const prefix = await fileSample(filePath, metadata.size);
  const oldAnchor = existing ? await fileSample(filePath, Math.min(256, existing.scanOffset), Math.max(0, existing.scanOffset - 256)) : '';
  const append = existing && existing.identity === identity && metadata.size > existing.scanOffset
    && metadata.size >= (existing.index?.session.fileSize ?? 0) && prefix === existing.prefix && oldAnchor === existing.anchor;
  const state = append ? existing : emptyState();
  state.partialTail = false;
  for await (const line of readLines(filePath, state.scanOffset, metadata.size)) {
    processLine(state, line);
    if (!line.partial) state.scanOffset = line.end;
  }
  state.fingerprint = fingerprint;
  state.identity = identity;
  state.prefix = prefix;
  state.anchor = await fileSample(filePath, Math.min(256, state.scanOffset), Math.max(0, state.scanOffset - 256));
  state.index = buildIndex(state, filePath, metadata.size, metadata.mtime.toISOString(), fingerprint);
  cache.delete(filePath); cache.set(filePath, state);
  while (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value!);
  return state;
}

async function getState(filePath: string): Promise<CachedIndex> {
  const absolute = path.resolve(filePath);
  const running = pending.get(absolute);
  if (running) return running;
  const promise = readIndex(absolute);
  pending.set(absolute, promise);
  try { return await promise; } finally { pending.delete(absolute); }
}

export async function indexSessionFile(filePath: string): Promise<IndexedSession> {
  const state = await getState(filePath);
  return state.index!;
}

export async function loadSessionRequests(filePath: string): Promise<RequestUsage[]> {
  const state = await getState(filePath);
  return state.ledger.requestsInOrder();
}

export async function loadSessionActivity(filePath: string): Promise<SessionActivity> {
  const state = await getState(filePath);
  const requests = state.ledger.requestsInOrder();
  const warnings: string[] = [];
  const compactions = state.compactions.map(({ offset, turnId, navigationTurnId: _navigationTurnId, ...marker }) => ({
    ...marker, ...(turnId && state.turns.has(turnId) ? { turnId } : {}),
    beforeRequestIndex: state.ledger.countRequestsBefore(offset),
  }));
  if (requests.some(request => request.source === 'snapshot-delta')) warnings.push('部分用量来自累计快照差值，可能覆盖多个缺失调用；图中记录数不一定等于实际调用数。');
  if (!requests.length) warnings.push('日志未记录可识别的模型调用用量，无法还原 token 变化。');
  if (compactions.some(marker => !marker.turnId)) warnings.push('部分压缩事件没有可确认的轮次归属，仍按原始日志顺序显示。');
  if (state.parseErrors) warnings.push(`跳过 ${state.parseErrors} 条损坏的日志记录，活动时间轴可能不完整。`);
  if (state.partialTail) warnings.push('日志末尾尚未写完，补齐后会自动更新。');
  if (typeof state.meta.subagent_history_start_ordinal === 'number') warnings.push('子会话的继承重放前缀已排除，仅显示其自身记录的活动。');
  if (requests.some(request => !request.timestamp) || compactions.some(marker => !marker.timestamp)
    || state.activityMessages.some(message => !message.timestamp)) warnings.push('部分记录没有时间戳，显示顺序以日志记录顺序为准。');
  return { requests, compactions, messages: state.activityMessages.slice(), warnings };
}

function toolCategory(name: string): ToolCall['category'] {
  if (/apply_patch|patch/i.test(name)) return 'patch';
  if (/exec_command|shell|stdin|terminal/i.test(name)) return 'command';
  if (/^mcp[_._]|^mcp__/i.test(name)) return 'mcp';
  if (/web|search_query|browse/i.test(name)) return 'web';
  if (/agent|collaboration|thread/i.test(name)) return 'agent';
  return 'other';
}

function inferOutput(payload: Json, output: string): Pick<ToolCall, 'status' | 'exitCode'> {
  let structured: Json = {};
  if (payload.output && typeof payload.output === 'object' && !Array.isArray(payload.output)) structured = payload.output;
  else { try { structured = JSON.parse(output); } catch { /* ordinary command output */ } }
  const exitMatch = output.match(/(?:exit(?:ed)?(?: with)? code|exit_code)\s*[:=]?\s*(-?\d+)/i);
  const exitCode = typeof structured.exit_code === 'number' ? structured.exit_code
    : typeof payload.exit_code === 'number' ? payload.exit_code : exitMatch ? Number(exitMatch[1]) : undefined;
  const failed = payload.is_error === true || payload.isError === true || structured.isError === true || structured.is_error === true
    || (exitCode != null && exitCode !== 0);
  return { status: failed ? 'failed' : 'completed', exitCode };
}

export async function loadTurnDetail(filePath: string, turnId: string): Promise<TurnDetail> {
  const state = await getState(filePath);
  const summary = state.index!.turns.find(turn => turn.id === turnId);
  if (!summary) throw new Error('未找到回合');
  const events: TimelineEvent[] = [];
  const calls = new Map<string, ToolCall>();
  const messageIds = new Set<string>();
  let hasEventPrompt = false;
  const push = (event: TimelineEvent) => {
    const key = `${event.kind}:${event.text}`;
    if (['user', 'assistant', 'commentary', 'reasoning'].includes(event.kind)) {
      if (messageIds.has(key)) return;
      messageIds.add(key);
    }
    events.push(event);
  };
  for await (const line of readLines(path.resolve(filePath), summary.startOffset, summary.endOffset)) {
    if (!line.value) continue;
    const value = line.value;
    const type = detectType(value);
    const payload = normalizedPayload(value, type);
    const timestamp = timestampOf(value);
    const message = classifyMessage(type, payload);
    if (message?.text) {
      let kind = message.kind as TimelineEvent['kind'];
      if (kind === 'user' && isInjected(message.text)) kind = 'context';
      if (kind === 'user' && message.eventPrompt) {
        hasEventPrompt = true;
        // The duplicate response_item prompt is retained once, at its original position.
      }
      if (!(kind === 'user' && !message.eventPrompt && hasEventPrompt && messageIds.has(`user:${message.text}`))) {
        push({ id: `event-${line.start}`, kind, timestamp, text: message.text, ...(message.collaboration ? { collaboration: message.collaboration } : {}) });
      }
    }
    const shape = toolShape(type, payload);
    if (shape) {
      const id = String(payload.call_id ?? payload.id ?? `tool-${line.start}`);
      if (shape === 'call') {
        const name = String(payload.name ?? (payload.type === 'web_search_call' ? 'web_search' : 'shell'));
        const existing = calls.get(id);
        if (existing) continue;
        const argumentsText = stringify(payload.arguments ?? payload.input ?? payload.action ?? {});
        const tool: ToolCall = { id, name, category: toolCategory(name), arguments: argumentsText,
          output: '', outputLength: 0, outputTruncated: false, status: payload.status === 'completed' ? 'completed' : 'running' };
        calls.set(id, tool);
        events.push({ id: `tool-${line.start}`, kind: 'tool', timestamp, text: name, tool });
      } else {
        const output = contentText(payload.output);
        let tool = calls.get(id);
        if (!tool) {
          tool = { id, name: '未知工具', category: 'other', arguments: '', output: '', outputLength: 0, outputTruncated: false, status: 'unknown' };
          calls.set(id, tool);
          events.push({ id: `tool-${line.start}`, kind: 'tool', timestamp, text: tool.name, tool });
        }
        Object.assign(tool, inferOutput(payload, output), { output: output.slice(0, DEFAULT_OUTPUT_LIMIT), outputLength: output.length, outputTruncated: output.length > DEFAULT_OUTPUT_LIMIT });
      }
    }
    if (type === 'turn_context') push({ id: `context-${line.start}`, kind: 'context', timestamp, text: JSON.stringify(payload, null, 2) });
    if (type === 'response_item' && payload.type === 'additional_tools') push({ id: `context-${line.start}`, kind: 'context', timestamp, text: JSON.stringify(payload, null, 2) });
    if (type === 'compacted') push({ id: `notice-${line.start}`, kind: 'notice', noticeType: 'compaction', timestamp, text: '上下文已压缩' });
    if (type === 'event_msg' && ['warning', 'error', 'turn_aborted'].includes(payload.type)) push({ id: `notice-${line.start}`, kind: 'notice', timestamp, text: String(payload.message ?? payload.reason ?? payload.type) });
    const knownItem = ['message', 'reasoning', 'additional_tools', 'agent_message', 'configuration_update'];
    if (!message && !shape && !ignoredTop.has(type) && type !== 'turn_context' && type !== 'compacted'
      && !(type === 'event_msg' && (ignoredEvents.has(payload.type) || ['warning', 'error'].includes(payload.type)))
      && !(type === 'response_item' && knownItem.includes(payload.type))) {
      push({ id: `unknown-${line.start}`, kind: 'unknown', timestamp, text: `${type}${payload.type && payload.type !== type ? ` / ${payload.type}` : ''}\n${JSON.stringify(payload, null, 2).slice(0, DEFAULT_OUTPUT_LIMIT)}` });
    }
  }
  for (const tool of calls.values()) if (tool.status === 'running' && summary.status !== 'running') tool.status = 'unknown';
  const warnings: string[] = [];
  if (state.parseErrors) warnings.push(`跳过 ${state.parseErrors} 条损坏的 JSONL 记录。`);
  if (state.partialTail) warnings.push('日志末尾有尚未写完的记录，补齐后会自动更新。');
  if (summary.usage.completeness === 'partial') warnings.push('部分用量来自累计快照差值，调用数量可能只是下界。');
  return { summary, events, requests: state.ledger.requestsForTurn(turnId), warnings };
}

/** Read only the failed turns needed for this page; summaries already contain final deduplicated counts. */
export async function loadToolFailures(filePath: string, offset = 0, limit = 20): Promise<ToolFailurePage> {
  const state = await getState(filePath);
  const turns = state.index!.turns.filter(turn => (turn.toolFailureCount ?? 0) > 0);
  const total = state.index!.session.toolFailureCount!;
  const from = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const count = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
  const items: ToolFailurePage['items'] = [];
  let skip = from;
  for (const turn of turns) {
    if (skip >= turn.toolFailureCount!) { skip -= turn.toolFailureCount!; continue; }
    const detail = await loadTurnDetail(filePath, turn.id);
    const failures = detail.events.filter(event => event.tool?.status === 'failed');
    for (const event of failures.slice(skip)) {
      items.push({ turnId: turn.id, eventId: event.id, toolId: event.tool!.id, toolName: event.tool!.name });
      if (items.length >= count) break;
    }
    skip = 0;
    if (items.length >= count) break;
  }
  return { items, total, nextOffset: from + items.length < total ? from + items.length : null };
}

/** Navigation metadata is indexed once; paging never loads transcript or compacted bodies. */
export async function loadCompactions(filePath: string, offset = 0, limit = 20): Promise<CompactionPage> {
  const state = await getState(filePath);
  const from = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const count = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
  const items = state.compactions.slice(from, from + count).map(marker => ({
    turnId: marker.navigationTurnId!, eventId: marker.id, timestamp: marker.timestamp,
  }));
  const total = state.compactions.length;
  return { items, total, nextOffset: from + items.length < total ? from + items.length : null };
}

export async function loadToolOutput(filePath: string, callId: string, offset = 0, limit = DEFAULT_OUTPUT_LIMIT): Promise<OutputPage> {
  const state = await getState(filePath);
  const location = state.outputs.get(callId);
  if (!location) throw new Error('未找到工具输出');
  const from = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const count = Number.isFinite(limit) ? Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(limit))) : DEFAULT_OUTPUT_LIMIT;
  for await (const line of readLines(path.resolve(filePath), location.start, location.end)) {
    if (!line.value) continue;
    const type = detectType(line.value);
    const payload = normalizedPayload(line.value, type);
    if (String(payload.call_id ?? payload.id) !== callId) continue;
    const output = contentText(payload.output);
    const text = output.slice(from, from + count);
    return { text, offset: from, nextOffset: from + text.length < output.length ? from + text.length : null, totalLength: output.length };
  }
  throw new Error('工具输出记录已变更，请刷新会话');
}
