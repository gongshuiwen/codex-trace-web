import { parentPort } from 'node:worker_threads';
import type { RequestUsage } from '../shared/types.js';
import { analyzeRequestContext } from './context-analysis.js';

if (!parentPort) throw new Error('上下文分析必须在后台线程运行。');
const port = parentPort;
let queue: Promise<void> = Promise.resolve();
port.on('message', (message: { id: number; file: string; request: RequestUsage }) => {
  queue = queue.then(async () => {
    try {
      const result = await analyzeRequestContext(message.file, message.request);
      port.postMessage({ id: message.id, result });
    } catch (error) {
      // Transcript text is never copied into error responses.
      port.postMessage({ id: message.id, error: error instanceof Error ? error.message : '无法分析此调用的上下文。' });
    }
  });
});
