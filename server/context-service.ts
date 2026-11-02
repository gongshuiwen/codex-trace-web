import { Worker } from 'node:worker_threads';
import type { RequestContextAnalysis, RequestUsage } from '../shared/types.js';

interface PendingAnalysis {
  resolve(value: RequestContextAnalysis): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** A separate lazy Worker keeps tokenization off HTTP and indexing threads. */
export class ContextAnalysisService {
  private worker: Worker | null = null;
  private pending = new Map<number, PendingAnalysis>();
  private nextId = 0;

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const isTypeScript = import.meta.url.endsWith('.ts');
    const workerUrl = new URL(isTypeScript ? './context-worker.ts' : './context-worker.js', import.meta.url);
    const worker = isTypeScript
      ? new Worker(`require('tsx/esm/api').register(); import(${JSON.stringify(workerUrl.href)});`, { eval: true })
      : new Worker(workerUrl);
    this.worker = worker;
    worker.on('message', (message: { id: number; result?: RequestContextAnalysis; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error || !message.result) pending.reject(new Error(message.error || '上下文分析没有返回结果。'));
      else pending.resolve(message.result);
    });
    const fail = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('上下文分析线程已退出，请重试。'));
      }
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', fail);
    return worker;
  }

  analyze(file: string, request: RequestUsage): Promise<RequestContextAnalysis> {
    if (this.pending.size >= 8) return Promise.reject(Object.assign(new Error('正在分析多个调用，请稍后重试。'), { statusCode: 429 }));
    const worker = this.getWorker();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('上下文分析超时，请稍后重试。'), { statusCode: 504 }));
        // A pathological record must not keep all future analyses queued forever.
        this.stop();
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, file, request });
    });
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('上下文分析已停止，请重试。'));
    }
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}
