import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { mkdir, readdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import chokidar, { type FSWatcher } from 'chokidar';
import { SessionStore, INDEX_SCHEMA_VERSION, type ListOptions } from './store.js';
import { indexSessionFile, loadSessionActivity } from './parser.js';
import type { IndexProgress, LiveEvent } from '../shared/types.js';

const port = parentPort;
if (!port) throw new Error('索引服务必须运行在 Worker Thread。');
const options = workerData as { sessionsDir: string; dataDir: string };
let root = path.resolve(options.sessionsDir);
let store: SessionStore;
let watcher: FSWatcher | null = null;
let stopped = false;
let scanning = false;
let rescanTimer: NodeJS.Timeout | null = null;
let changeTimer: NodeJS.Timeout | null = null;
const updateTimers = new Map<string, NodeJS.Timeout>();
const indexing = new Map<string, Promise<void>>();
let progress: IndexProgress = { status: 'scanning', discovered: 0, indexed: 0, errors: 0 };
let lastProgressAt = 0;

function send(event: LiveEvent): void {
  if (!stopped) port!.postMessage({ type: 'event', event });
}

function progressEvent(force = false): void {
  if (force || Date.now() - lastProgressAt > 250) {
    lastProgressAt = Date.now();
    send({ type: 'index-progress', progress: { ...progress } });
  }
}

function sessionsChanged(): void {
  if (changeTimer || stopped) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    send({ type: 'sessions-changed', progress: { ...progress } });
  }, 300);
}

function isInsideRoot(candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function indexFile(file: string): Promise<void> {
  const old = indexing.get(file);
  if (old) return old;
  const task = (async () => {
    if (stopped || !file.endsWith('.jsonl')) return;
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return;
      const canonical = await realpath(file);
      if (!isInsideRoot(canonical)) return;
      const fingerprint = store.fingerprint(file);
      if (fingerprint?.size === metadata.size && fingerprint.mtimeMs === metadata.mtimeMs) return;
      const data = await indexSessionFile(file);
      if (stopped) return;
      // Fingerprint the bytes actually parsed. Appends occurring during a scan
      // must remain eligible for the next pass rather than getting marked fresh.
      const after = await lstat(file);
      const stable = after.size === metadata.size && after.mtimeMs === metadata.mtimeMs;
      store.upsert(data, file, stable ? metadata.size : -1, stable ? metadata.mtimeMs : -1);
      send({ type: 'session-changed', sessionId: data.session.id, revision: data.session.revision });
      sessionsChanged();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        const id = store.removePath(file);
        if (id) { send({ type: 'session-changed', sessionId: id }); sessionsChanged(); }
      } else {
        progress.errors++;
        progress.message = `部分日志无法读取：${errorText(error)}`;
        progressEvent(true);
      }
    }
  })();
  indexing.set(file, task);
  try { await task; } finally { indexing.delete(file); }
}

async function* discover(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    if (stopped) return;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      try { yield* discover(file); }
      catch (error) {
        progress.errors++;
        progress.message = `部分目录无法读取：${errorText(error)}`;
        progressEvent(true);
      }
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield file;
    }
  }
}

async function scan(): Promise<void> {
  if (scanning || stopped) return;
  scanning = true;
  progress = { status: 'scanning', discovered: 0, indexed: 0, errors: 0 };
  progressEvent(true);
  const seen = new Set<string>();
  try {
    for await (const file of discover(root)) {
      if (stopped) break;
      seen.add(file);
      progress.discovered++;
      await indexFile(file);
      progress.indexed++;
      progressEvent();
      await yieldToWorker();
    }
    // Avoid dropping cached summaries when part of a tree is inaccessible.
    if (!stopped && progress.errors === 0) {
      for (const file of store.paths()) {
        if (!seen.has(file)) { store.removePath(file); sessionsChanged(); }
      }
    }
    if (!stopped) progress.status = 'ready';
  } catch (error) {
    progress.status = 'error';
    progress.message = `无法读取日志目录：${errorText(error)}`;
    progress.errors++;
  } finally {
    scanning = false;
    progressEvent(true);
    sessionsChanged();
  }
}

function scheduleFile(file: string): void {
  if (stopped || !file.endsWith('.jsonl')) return;
  const previous = updateTimers.get(file);
  if (previous) clearTimeout(previous);
  updateTimers.set(file, setTimeout(() => {
    updateTimers.delete(file);
    void indexFile(file);
  }, 350));
}

async function stop(): Promise<void> {
  if (stopped) return;
  stopped = true;
  if (rescanTimer) clearInterval(rescanTimer);
  if (changeTimer) clearTimeout(changeTimer);
  for (const timer of updateTimers.values()) clearTimeout(timer);
  updateTimers.clear();
  await watcher?.close();
  await Promise.allSettled(indexing.values());
  store?.close();
  port!.close();
}

async function safePath(id: string): Promise<string | null> {
  const file = store.getPath(id);
  if (!file) return null;
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !isInsideRoot(await realpath(file))) return null;
    return file;
  } catch { return null; }
}

port.on('message', async (message: { id?: number; method: string; args: unknown[] }) => {
  try {
    let result: unknown;
    if (message.method === 'stop') { await stop(); return; }
    if (!store) throw new Error('索引缓存尚未就绪。');
    switch (message.method) {
      case 'list': result = store.list((message.args[0] || {}) as ListOptions, { ...progress }); break;
      case 'get': result = store.get(String(message.args[0])); break;
      case 'children': result = store.children(String(message.args[0]), (message.args[1] || {}) as ListOptions); break;
      case 'getPath': result = await safePath(String(message.args[0])); break;
      case 'activity': {
        const file = await safePath(String(message.args[0]));
        result = file ? await loadSessionActivity(file) : null;
        break;
      }
      default: throw new Error('未知索引操作。');
    }
    port!.postMessage({ type: 'response', id: message.id, result });
  } catch (error) {
    port!.postMessage({ type: 'response', id: message.id, error: errorText(error) });
  }
});

try {
  await mkdir(options.dataDir, { recursive: true });
  try { root = await realpath(root); } catch { /* Empty or unavailable root is shown as an index error. */ }
  const hash = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 20);
  store = new SessionStore(path.join(options.dataDir, `index-v${INDEX_SCHEMA_VERSION}-${hash}.sqlite`));
  port.postMessage({ type: 'ready' });
  watcher = chokidar.watch(root, { ignoreInitial: true, followSymlinks: false, atomic: true });
  watcher.on('add', scheduleFile).on('change', scheduleFile);
  watcher.on('unlink', file => {
    const id = store.removePath(file);
    if (id) { send({ type: 'session-changed', sessionId: id }); sessionsChanged(); }
  });
  watcher.on('error', error => {
    progress.errors++;
    progress.message = `文件监听暂不可用，将定期重新扫描：${errorText(error)}`;
    progressEvent(true);
  });
  rescanTimer = setInterval(() => { void scan(); }, 30000);
  void scan();
} catch (error) {
  port.postMessage({ type: 'fatal', error: errorText(error) });
  port.close();
}
