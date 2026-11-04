import type { ToolCall } from '../shared/types';

export interface PatchFile {
  path: string;
  kind: 'add' | 'update' | 'delete' | 'move';
  movedTo?: string;
  lines: string[];
}

export interface ToolPresentation {
  category: ToolCall['category'];
  title: string;
  subtitle?: string;
  command?: string;
  cwd?: string;
  shell?: string;
  diagnostic?: string;
  patchFiles: PatchFile[];
  queries: string[];
  target?: string;
}

export interface ToolOutput {
  text: string;
  json?: unknown;
  exitCode?: number;
  envelope: boolean;
}

export interface WebResultLink {
  title: string;
  url: string;
  snippet?: string;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function parse(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function summary(value: string | undefined, limit = 180): string | undefined {
  if (!value) return undefined;
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function methodName(name: string): string {
  return name.split(/__|[./:]/).filter(Boolean).at(-1) ?? name;
}

function leafName(name: string): string {
  return methodName(name).toLowerCase();
}

function isExecScript(name: string): boolean {
  return /^(?:functions[._]{1,2})?exec$/i.test(name);
}

function categoryOf(tool: ToolCall): ToolCall['category'] {
  const leaf = leafName(tool.name);
  // The exec orchestrator contains code, rather than an independently recorded shell command.
  if (isExecScript(tool.name)) return 'other';
  if (['exec_command', 'write_stdin', 'shell', 'local_shell', 'local_shell_call', 'terminal'].includes(leaf)) return 'command';
  if (leaf === 'apply_patch') return 'patch';
  if (/^(?:web[._]{1,2})(?:run|search_query|image_query)$/i.test(tool.name) || leaf === 'web_search') return 'web';
  if (tool.category !== 'other') return tool.category;
  if (['spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'interrupt_agent', 'list_agents'].includes(leaf)) return 'agent';
  if (['search_query', 'web_search_call'].includes(leaf)) return 'web';
  if (/^mcp[._]/i.test(tool.name)) return 'mcp';
  return tool.category;
}

/** Decode only complete results. A truncated JSON prefix must remain a text fragment. */
export function readToolOutput(output: string, complete: boolean): ToolOutput {
  if (!complete) return { text: output, envelope: false };
  const json = parse(output);
  if (json === undefined) return { text: output, envelope: false };
  const object = record(json);
  const envelope = !!object && typeof object.output === 'string'
    && ['exit_code', 'session_id', 'wall_time_seconds', 'chunk_id', 'original_token_count'].some(key => key in object);
  return {
    text: envelope ? object!.output as string : output,
    json,
    envelope,
    ...(envelope && typeof object!.exit_code === 'number' && Number.isFinite(object!.exit_code) ? { exitCode: object!.exit_code } : {}),
  };
}

/** Recognize a whole result list; unknown or mixed content must retain its JSON view. */
export function webResultLinks(value: unknown): WebResultLink[] {
  const object = record(value);
  const entries = Array.isArray(value) ? value : Array.isArray(object?.results) ? object.results
    : Array.isArray(object?.search_results) ? object.search_results : undefined;
  if (!entries?.length) return [];
  const links: WebResultLink[] = [];
  for (const entry of entries) {
    const item = record(entry);
    const title = firstString(item?.title);
    const url = firstString(item?.url);
    if (!title || !url || !/^https?:\/\//i.test(url) || /[\u0000-\u0020\u007f]/.test(url)) return [];
    try {
      const parsedUrl = new URL(url);
      if (!parsedUrl.hostname || !['http:', 'https:'].includes(parsedUrl.protocol)) return [];
    } catch { return []; }
    const snippet = firstString(item?.snippet, item?.description);
    links.push({ title, url, ...(snippet ? { snippet } : {}) });
  }
  return links;
}

function diagnosticFor(tool: ToolCall): string | undefined {
  if (tool.status !== 'failed') return undefined;
  const output = readToolOutput(tool.output, !tool.outputTruncated);
  const object = record(output.json);
  const error = record(object?.error);
  const explicit = firstString(object?.error, error?.message,
    object?.isError === true || object?.is_error === true ? object?.message : undefined);
  if (explicit) return summary(explicit, 280);
  const candidate = output.text.split(/\r?\n/).find(line =>
    /^\s*(?:(?:[\w.]+(?:Error|Exception)|error|exception|fatal)\s*:|(?:npm\s+ERR!|ERR_PNPM_[A-Z_]+)(?=\s|:|$)|(?:CategoryInfo|FullyQualifiedErrorId)\s*:)/i.test(line)
    || /^\s*.+(?:\(\d+,\d+\)|:\d+(?::\d+)?):\s*(?:fatal\s+)?error\b/i.test(line));
  return summary(candidate, 280);
}

function codexPatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) {
      current = { path: header[2]!.trim(), kind: header[1]!.toLowerCase() as PatchFile['kind'], lines: [] };
      files.push(current);
    } else if (current && line.startsWith('*** Move to: ')) {
      current.kind = 'move'; current.movedTo = line.slice('*** Move to: '.length).trim();
    } else if (line === '*** End Patch') {
      current = undefined;
    } else if (current && line !== '*** End of File') {
      current.lines.push(line);
    }
  }
  return files;
}

function diffPath(value: string): string {
  let path = value.split('\t')[0]!.trim();
  if (path.startsWith('"') && path.endsWith('"')) {
    const decoded = parse(path);
    if (typeof decoded === 'string') path = decoded;
  }
  return path === '/dev/null' ? path : path.replace(/^[ab]\//, '');
}

function unifiedPatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: { oldPath?: string; newPath?: string; lines: string[]; hasHeaders?: boolean } | undefined;
  let oldRemaining = 0;
  let newRemaining = 0;
  function finish() {
    if (!current) return;
    const { oldPath, newPath, lines } = current;
    const path = oldPath && oldPath !== '/dev/null' ? oldPath : newPath;
    if (path && path !== '/dev/null') {
      const kind: PatchFile['kind'] = oldPath === '/dev/null' ? 'add' : newPath === '/dev/null' ? 'delete'
        : oldPath && newPath && oldPath !== newPath ? 'move' : 'update';
      files.push({ path, kind, ...(kind === 'move' ? { movedTo: newPath } : {}), lines });
    }
  }
  for (const line of text.split(/\r?\n/)) {
    // Hunk content can itself start with --- / +++. Its counts distinguish it from file headers.
    if (current && (oldRemaining > 0 || newRemaining > 0) && /^[ +\-\\]/.test(line)) {
      current.lines.push(line);
      if (line.startsWith(' ') || line.startsWith('-')) oldRemaining--;
      if (line.startsWith(' ') || line.startsWith('+')) newRemaining--;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      finish();
      oldRemaining = 0; newRemaining = 0;
      const paths = line.match(/^diff --git ("(?:[^"\\]|\\.)+"|a\/.+) ("(?:[^"\\]|\\.)+"|b\/.+)$/);
      current = { oldPath: paths ? diffPath(paths[1]!) : undefined, newPath: paths ? diffPath(paths[2]!) : undefined, lines: [] };
    } else if (line.startsWith('--- ')) {
      if (current?.hasHeaders) { finish(); current = undefined; }
      oldRemaining = 0; newRemaining = 0;
      current ??= { lines: [] };
      current.oldPath = diffPath(line.slice(4));
    } else if (line.startsWith('+++ ') && current) {
      current.newPath = diffPath(line.slice(4)); current.hasHeaders = true;
    } else if (current && line.startsWith('rename from ')) {
      current.oldPath = diffPath(line.slice(12));
    } else if (current && line.startsWith('rename to ')) {
      current.newPath = diffPath(line.slice(10));
    } else if (current && line.startsWith('@@')) {
      const counts = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
      if (counts) { oldRemaining = Number(counts[1] ?? 1); newRemaining = Number(counts[2] ?? 1); }
      current.lines.push(line);
    } else if (current && /^(?:@@|[ +\-\\])/.test(line)) {
      current.lines.push(line);
    }
  }
  finish();
  return files;
}

function patchFiles(text: string): PatchFile[] {
  const codex = codexPatch(text);
  return codex.length ? codex : unifiedPatch(text);
}

function searchQueries(args: RecordValue | undefined): string[] {
  const queries: string[] = [];
  function add(value: unknown) {
    const query = firstString(value);
    if (query && !queries.includes(query)) queries.push(query);
  }
  add(args?.query); add(args?.q);
  for (const key of ['search_query', 'image_query', 'queries', 'search_queries']) {
    const value = args?.[key];
    if (Array.isArray(value)) for (const entry of value) {
      if (typeof entry === 'string') add(entry);
      else { const item = record(entry); add(item?.q ?? item?.query); }
    }
    else if (typeof value === 'string') add(value);
  }
  return queries;
}

function commandValue(value: unknown): string | undefined {
  if (typeof value === 'string') return firstString(value);
  if (Array.isArray(value) && value.length && value.every(item => typeof item === 'string')) {
    return value.map(item => /\s|["']/.test(item as string) ? JSON.stringify(item) : item).join(' ');
  }
  return undefined;
}

export function toolPresentation(tool: ToolCall): ToolPresentation {
  const parsedArguments = parse(tool.arguments);
  const args = record(parsedArguments);
  const category = categoryOf(tool);
  const script = isExecScript(tool.name);
  const leaf = leafName(tool.name);
  const action = record(args?.action);
  const execAction = action?.type === 'exec' ? action : undefined;
  const command = category === 'command' ? commandValue(args?.cmd ?? args?.command ?? execAction?.command) : undefined;
  const cwd = firstString(args?.workdir, args?.cwd, args?.working_directory, execAction?.working_directory);
  const shell = firstString(args?.shell, execAction?.shell);
  const queries = searchQueries(args);
  const patch = category === 'patch' ? patchFiles(firstString(args?.patch, args?.patch_text, args?.input,
    typeof parsedArguments === 'string' ? parsedArguments : undefined) ?? tool.arguments) : [];
  const open = Array.isArray(args?.open) ? record(args.open[0]) : undefined;
  const target = firstString(args?.file_path, args?.path, args?.file, args?.filename, args?.target_path,
    args?.url, args?.task_name, args?.target, args?.agent_id, args?.thread_id, open?.ref_id,
    args?.table, args?.collection, args?.resource, args?.document_id, args?.page_id);
  let title: string;
  let subtitle: string | undefined;
  if (script) {
    title = '执行脚本';
    const code = firstString(args?.code, args?.script, typeof parsedArguments === 'string' ? parsedArguments : undefined) ?? tool.arguments;
    subtitle = summary(code.split(/\r?\n/).find(line => line.trim() && !/^\s*\/\/\s*@exec:/.test(line)));
  } else if (category === 'command') {
    title = leaf === 'write_stdin' ? '继续读取进程' : '运行命令';
    subtitle = summary(command ?? target ?? (args?.session_id != null ? `进程 ${String(args.session_id)}` : undefined));
  } else if (category === 'patch') {
    title = '请求文件变更';
    subtitle = patch.length ? summary(`${patch[0]!.path}${patch.length > 1 ? ` · 共 ${patch.length} 个文件` : ''}`) : summary(target);
  } else if (category === 'web') {
    title = queries.length ? '搜索资料' : open || args?.url ? '读取网页' : '调用网络工具';
    subtitle = summary(queries.length ? queries.join('；') : target);
  } else if (category === 'agent') {
    title = ({ spawn_agent: '启动子代理', send_message: '发送协作消息', followup_task: '追加协作任务',
      wait_agent: '等待子代理', interrupt_agent: '停止子代理', list_agents: '查看子代理' } as Record<string, string>)[leaf] ?? '子代理协作';
    subtitle = summary(target);
  } else {
    title = category === 'mcp' ? `调用 ${methodName(tool.name)}` : '调用工具';
    subtitle = summary(target ?? queries[0]);
  }
  title = summary(firstString(args?.title, args?.description), 120) ?? title;
  return { category, title, subtitle, command, cwd, shell, diagnostic: diagnosticFor(tool), patchFiles: patch, queries, target };
}
