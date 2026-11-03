import { parentPort } from 'node:worker_threads';
import type { ContextCategory, RequestUsage } from '../shared/types.js';
import { analyzeRequestContext, compareRequestContext, loadContextSources } from './context-analysis.js';
import { loadSessionRequests } from './parser.js';

if (!parentPort) throw new Error('上下文分析必须在后台线程运行。');
const port = parentPort;
let queue: Promise<void> = Promise.resolve();
port.on('message', (message: { id: number; operation?: string; file: string; request: RequestUsage; category?: ContextCategory; offset?: number; limit?: number }) => {
  queue = queue.then(async () => {
    try {
      let result;
      if (message.operation === 'sources') {
        if (!message.category) throw new Error('缺少上下文分类。');
        result = await loadContextSources(message.file, message.request, message.category, message.offset, message.limit);
      } else if (message.operation === 'comparison') {
        const requests = await loadSessionRequests(message.file);
        const current = requests.findIndex(request => request.id === message.request.id && request.turnId === message.request.turnId);
        if (current < 0) throw new Error('调用记录已变更，请刷新后重试。');
        result = await compareRequestContext(message.file, requests[current], current > 0 ? requests[current - 1] : null);
      } else result = await analyzeRequestContext(message.file, message.request);
      port.postMessage({ id: message.id, result });
    } catch (error) {
      // Transcript text is never copied into error responses.
      port.postMessage({ id: message.id, error: error instanceof Error ? error.message : '无法分析此调用的上下文。' });
    }
  });
});
