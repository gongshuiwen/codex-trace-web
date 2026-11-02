import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IndexProgress, LiveEvent, SessionDetail, SessionList } from '../shared/types.js';
import type { ListOptions } from './store.js';

interface WorkerMessage {
  type: 'ready' | 'event' | 'response' | 'fatal';
  id?: number;
  result?: unknown;
  error?: string;
  event?: LiveEvent;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface IndexServiceOptions {
  sessionsDir: string;
  dataDir: string;
}

export class IndexService extends EventEmitter {
  readonly dataDir: string;
  sessionsDir: string;
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private starting: Promise<void> | null = null;
  private _progress: IndexProgress = { status: 'scanning', discovered: 0, indexed: 0, errors: 0 };

  constructor(options: IndexServiceOptions) {
    super();
    this.sessionsDir = path.resolve(options.sessionsDir);
    this.dataDir = path.resolve(options.dataDir);
  }

  get progress(): IndexProgress {
    return { ...this._progress };
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startWorker();
    try { await this.starting; } finally { this.starting = null; }
  }

  private async startWorker(): Promise<void> {
    if (this.worker) return;
    await mkdir(this.dataDir, { recursive: true });
    const isTypeScript = import.meta.url.endsWith('.ts');
    const workerUrl = new URL(isTypeScript ? './index-worker.ts' : './index-worker.js', import.meta.url);
    // tsx's import hook must be registered inside a Worker rather than inherited.
    const worker = isTypeScript
      ? new Worker(`require('tsx/esm/api').register(); import(${JSON.stringify(workerUrl.href)});`, {
        eval: true,
        workerData: { sessionsDir: this.sessionsDir, dataDir: this.dataDir },
      })
      : new Worker(workerUrl, { workerData: { sessionsDir: this.sessionsDir, dataDir: this.dataDir } });
    this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => reject(new Error('索引服务启动超时。')), 15000);
      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'ready') {
          ready = true;
          clearTimeout(timeout);
          resolve();
        } else if (message.type === 'event' && message.event) {
          if (message.event.progress) this._progress = message.event.progress;
          this.emit('change', message.event);
        } else if (message.type === 'response' && message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error));
            else pending.resolve(message.result);
          }
        } else if (message.type === 'fatal') {
          const error = new Error(message.error || '索引服务发生错误。');
          if (!ready) { clearTimeout(timeout); reject(error); }
          this.markError(error);
        }
      });
      worker.on('error', error => {
        clearTimeout(timeout);
        if (!ready) reject(error);
        this.markError(error);
      });
      worker.on('exit', code => {
        if (this.worker === worker) {
          this.worker = null;
          if (code !== 0) this.markError(new Error(`索引服务已停止（${code}）。`));
        }
      });
    });
  }

  private markError(error: Error): void {
    this._progress = { ...this._progress, status: 'error', message: error.message };
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
    this.emit('change', { type: 'index-progress', progress: this.progress } satisfies LiveEvent);
  }

  private async request<T>(method: string, args: unknown[] = []): Promise<T> {
    await this.start();
    const worker = this.worker;
    if (!worker) throw new Error('索引服务尚未启动。');
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('索引查询超时，请稍后重试。')); }, 30000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timeout });
      worker.postMessage({ id, method, args });
    });
  }

  list(options: ListOptions = {}): Promise<SessionList> { return this.request('list', [options]); }
  get(id: string): Promise<SessionDetail | null> { return this.request('get', [id]); }
  getPath(id: string): Promise<string | null> { return this.request('getPath', [id]); }

  async setDirectory(directory: string): Promise<void> {
    const resolved = await realpath(directory);
    await access(resolved);
    if (!(await stat(resolved)).isDirectory()) throw new Error('请选择一个可读取的日志目录。');
    if (resolved === this.sessionsDir) return;
    await this.stop();
    this.sessionsDir = resolved;
    this._progress = { status: 'scanning', discovered: 0, indexed: 0, errors: 0 };
    await this.start();
    this.emit('change', { type: 'sessions-changed', progress: this.progress } satisfies LiveEvent);
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('索引服务正在切换目录。'));
    }
    this.pending.clear();
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { void worker.terminate().then(() => resolve()); }, 3000);
      worker.once('exit', () => { clearTimeout(timeout); resolve(); });
      worker.postMessage({ method: 'stop', args: [] });
    });
  }
}
