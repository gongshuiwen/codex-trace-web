import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { access, realpath, stat } from 'node:fs/promises';
import type { AppSettings, ContextCategory, LiveEvent, ToolCall, ToolSearchMatch } from '../shared/types.js';
import type { IndexService } from './indexer.js';
import { loadTurnDetail, loadToolOutput, loadToolFailures, loadCompactions } from './parser.js';
import { ContextAnalysisService } from './context-service.js';

interface AppOptions {
  index: IndexService;
  settings: AppSettings;
  saveSettings?: (settings: AppSettings) => Promise<void>;
  clientDir?: string;
  logger?: boolean;
}

/** Include overlapping literal matches, mapping lowercase expansions back to original UTF-16 spans. */
function* literalMatches(text: string, needle: string): Generator<{ offset: number; length: number }> {
  if (!needle) return;
  const folded = text.toLowerCase();
  let position = folded.indexOf(needle);
  if (position < 0) return;
  if (folded.length === text.length) {
    while (position >= 0) {
      yield { offset: position, length: needle.length };
      position = folded.indexOf(needle, position + 1);
    }
    return;
  }

  // Starts and ends advance independently so overlapping matches can share source characters.
  const sourceBoundary = (end: boolean) => {
    let sourceOffset = 0;
    let foldedOffset = 0;
    return (position: number): number => {
      while (sourceOffset < text.length) {
        const point = String.fromCodePoint(text.codePointAt(sourceOffset)!);
        const foldedLength = point.toLowerCase().length;
        const next = foldedOffset + foldedLength;
        if (position < next) {
          return sourceOffset + (foldedLength === point.length ? position - foldedOffset : end && position > foldedOffset ? point.length : 0);
        }
        sourceOffset += point.length;
        foldedOffset = next;
      }
      return sourceOffset;
    };
  };
  const sourceStart = sourceBoundary(false);
  const sourceEnd = sourceBoundary(true);
  let previousOffset = -1;
  let previousLength = 0;
  while (position >= 0) {
    const offset = sourceStart(position);
    const length = sourceEnd(position + needle.length) - offset;
    if (offset !== previousOffset || length !== previousLength) {
      yield { offset, length };
      previousOffset = offset; previousLength = length;
    }
    position = folded.indexOf(needle, position + 1);
  }
}

function matchExcerpt(text: string, match: { offset: number; length: number }): { text: string; excerptOffset: number } {
  let start = Math.max(0, match.offset - 70);
  let end = Math.min(text.length, match.offset + match.length + 160);
  // Keep the excerpt readable when a context boundary falls inside an emoji or another surrogate pair.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end++;
  return { text: text.slice(start, end), excerptOffset: start };
}

async function completeToolOutput(file: string, tool: ToolCall): Promise<string> {
  if (!tool.outputTruncated) return tool.output;
  const parts = [tool.output];
  let offset = tool.output.length;
  while (true) {
    const page = await loadToolOutput(file, tool.id, offset, 65536);
    parts.push(page.text);
    if (page.nextOffset === null || page.nextOffset <= offset) break;
    offset = page.nextOffset;
  }
  return parts.join('');
}

export async function createApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16 * 1024 });
  let settings = { ...options.settings };
  const { index } = options;
  const contextAnalysis = new ContextAnalysisService();
  let settingsChange: Promise<void> = Promise.resolve();
  const streams = new Set<{ close: () => void }>();

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
      return reply.code(403).send({ message: '请通过本机 localhost 或 127.0.0.1 访问。' });
    }
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      const origin = request.headers.origin;
      if (origin && ![ `http://${host}`, 'http://127.0.0.1:5173', 'http://localhost:5173' ].includes(origin)) {
        return reply.code(403).send({ message: '此接口仅允许本机应用页面访问。' });
      }
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  app.setErrorHandler((error, _request, reply) => {
    const failure = error as Error & { statusCode?: number };
    const status = typeof failure.statusCode === 'number' && failure.statusCode >= 400 ? failure.statusCode : 500;
    app.log.error(error);
    reply.code(status).send({ message: status >= 500 ? '读取日志时发生错误，请稍后重试。' : failure.message });
  });

  async function sessionPath(id: string): Promise<string> {
    const candidate = await index.getPath(id);
    if (!candidate) throw Object.assign(new Error('未找到此会话。'), { statusCode: 404 });
    try {
      const [root, file] = await Promise.all([realpath(settings.sessionsDir), realpath(candidate)]);
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw Object.assign(new Error('日志路径超出已设置的目录。'), { statusCode: 403 });
      }
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw Object.assign(new Error('会话日志已被移动或删除。'), { statusCode: 404 });
      }
      throw error;
    }
  }

  async function contextRequest(id: string, turnId: string, requestId: string) {
    const file = await sessionPath(id);
    const session = await index.get(id);
    if (!session?.turns.some(turn => turn.id === turnId)) {
      throw Object.assign(new Error('未找到此轮次。'), { statusCode: 404 });
    }
    const turn = await loadTurnDetail(file, turnId);
    const modelRequest = turn.requests.find(item => item.id === requestId);
    if (!modelRequest) throw Object.assign(new Error('未找到此轮次中的模型调用。'), { statusCode: 404 });
    return { file, modelRequest };
  }

  app.get('/api/health', async () => ({ ok: true, progress: index.progress }));
  app.get('/api/settings', async () => settings);
  app.put<{ Body: { sessionsDir: string } }>('/api/settings', {
    schema: { body: { type: 'object', required: ['sessionsDir'], additionalProperties: false, properties: {
      sessionsDir: { type: 'string', minLength: 1, maxLength: 4096 },
    } } },
  }, async (request) => {
    const nextDirectory = path.resolve(request.body.sessionsDir);
    try {
      if (!(await stat(nextDirectory)).isDirectory()) throw new Error('not-directory');
      await access(nextDirectory);
    } catch {
      throw Object.assign(new Error('目录不存在或无法读取，请填写日志目录的完整路径。'), { statusCode: 400 });
    }
    const change = settingsChange.then(async () => {
      const previous = settings;
      const next = { ...settings, sessionsDir: await realpath(nextDirectory) };
      try {
        await index.setDirectory(next.sessionsDir);
        await options.saveSettings?.(next);
        settings = next;
      } catch (error) {
        try { await index.setDirectory(previous.sessionsDir); }
        catch (rollbackError) { app.log.error(rollbackError, '切换日志目录失败且旧索引恢复失败。'); }
        throw error;
      }
    });
    settingsChange = change.catch(() => {});
    await change;
    return settings;
  });

  app.get<{ Querystring: { query?: string; project?: string; selectedId?: string; cursor?: number; limit?: number } }>('/api/sessions', {
    schema: { querystring: { type: 'object', properties: {
      query: { type: 'string', maxLength: 500 }, project: { type: 'string', maxLength: 4096 },
      selectedId: { type: 'string', maxLength: 256 },
      cursor: { type: 'integer', minimum: 0, maximum: 10000000, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    } } },
  }, async (request) => index.list({ ...request.query, cursor: request.query.cursor ?? 0, limit: request.query.limit ?? 50 }));

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request) => {
    const detail = await index.get(request.params.id);
    if (!detail) throw Object.assign(new Error('未找到此会话，可能仍在索引中。'), { statusCode: 404 });
    return detail;
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: number; limit?: number } }>('/api/sessions/:id/children', {
    schema: { querystring: { type: 'object', properties: {
      cursor: { type: 'integer', minimum: 0, maximum: 10000000, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    } } },
  }, async request => {
    const page = await index.children(request.params.id, request.query);
    if (!page) throw Object.assign(new Error('未找到此父会话。'), { statusCode: 404 });
    return page;
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/activity', async request => {
    const activity = await index.activity(request.params.id);
    if (!activity) throw Object.assign(new Error('未找到此会话活动，日志可能已被移动或删除。'), { statusCode: 404 });
    return activity;
  });

  app.get<{ Params: { id: string; turnId: string } }>('/api/sessions/:id/turns/:turnId', async (request) => {
    const file = await sessionPath(request.params.id);
    return loadTurnDetail(file, request.params.turnId);
  });

  app.get<{ Params: { id: string; requestId: string }; Querystring: { turnId: string } }>(
    '/api/sessions/:id/requests/:requestId/context', {
      schema: { querystring: { type: 'object', required: ['turnId'], properties: {
        turnId: { type: 'string', minLength: 1, maxLength: 256 },
      } } },
    }, async (request) => {
      const { file, modelRequest } = await contextRequest(request.params.id, request.query.turnId, request.params.requestId);
      return contextAnalysis.analyze(file, modelRequest);
    },
  );

  app.get<{ Params: { id: string; requestId: string }; Querystring: { turnId: string; category: ContextCategory; offset?: number; limit?: number } }>(
    '/api/sessions/:id/requests/:requestId/context/sources', {
      schema: { querystring: { type: 'object', required: ['turnId', 'category'], additionalProperties: false, properties: {
        turnId: { type: 'string', minLength: 1, maxLength: 256 },
        category: { type: 'string', enum: ['userMessages', 'projectInstructions', 'skills', 'toolDefinitions', 'toolOutputs', 'other'] },
        offset: { type: 'integer', minimum: 0, maximum: 10000000, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      } } },
    }, async request => {
      const { file, modelRequest } = await contextRequest(request.params.id, request.query.turnId, request.params.requestId);
      return contextAnalysis.sources(file, modelRequest, request.query.category, request.query.offset ?? 0, request.query.limit ?? 20);
    },
  );

  app.get<{ Params: { id: string; requestId: string }; Querystring: { turnId: string } }>(
    '/api/sessions/:id/requests/:requestId/comparison', {
      schema: { querystring: { type: 'object', required: ['turnId'], additionalProperties: false, properties: {
        turnId: { type: 'string', minLength: 1, maxLength: 256 },
      } } },
    }, async request => {
      const { file, modelRequest } = await contextRequest(request.params.id, request.query.turnId, request.params.requestId);
      return contextAnalysis.comparison(file, modelRequest);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { offset?: number; limit?: number } }>(
    '/api/sessions/:id/compactions', {
      schema: { querystring: { type: 'object', properties: {
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      } } },
    }, async request => loadCompactions(await sessionPath(request.params.id), request.query.offset ?? 0, request.query.limit ?? 20),
  );

  app.get<{ Params: { id: string }; Querystring: { offset?: number; limit?: number } }>(
    '/api/sessions/:id/tools/failures', {
      schema: { querystring: { type: 'object', properties: {
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      } } },
    }, async request => loadToolFailures(await sessionPath(request.params.id), request.query.offset ?? 0, request.query.limit ?? 20),
  );

  app.get<{ Params: { id: string; callId: string }; Querystring: { offset?: number; limit?: number } }>(
    '/api/sessions/:id/tools/:callId/output', {
      schema: { querystring: { type: 'object', properties: {
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 65536, default: 16384 },
      } } },
    }, async (request) => loadToolOutput(await sessionPath(request.params.id), request.params.callId,
      request.query.offset ?? 0, request.query.limit ?? 16384),
  );

  app.get<{ Params: { id: string }; Querystring: { query: string } }>('/api/sessions/:id/search', {
    schema: { querystring: { type: 'object', required: ['query'], properties: {
      query: { type: 'string', minLength: 1, maxLength: 500 },
    } } },
  }, async (request) => {
    const session = await index.get(request.params.id);
    if (!session) throw Object.assign(new Error('未找到此会话。'), { statusCode: 404 });
    const file = await sessionPath(request.params.id);
    const needle = request.query.query.toLowerCase();
    const matches: ToolSearchMatch[] = [];
    for (const turn of session.turns) {
      const detail = await loadTurnDetail(file, turn.id);
      for (const event of detail.events) {
        if (!event.tool) continue;
        const tool = event.tool;
        for (const field of ['arguments', 'output'] as const) {
          const text = field === 'arguments' ? tool.arguments : await completeToolOutput(file, tool);
          for (const match of literalMatches(text, needle)) {
            // Probe one more occurrence before claiming that the first 100 were truncated.
            if (matches.length === 100) return { matches, truncated: true };
            matches.push({ turnId: turn.id, eventId: event.id, toolId: tool.id, toolName: tool.name,
              field, ...match, matchedText: text.slice(match.offset, match.offset + match.length), ...matchExcerpt(text, match) });
          }
        }
      }
    }
    return { matches, truncated: false };
  });

  app.get<{ Querystring: { sessionId?: string } }>('/api/events', async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const send = (event: LiveEvent) => {
      if (event.type === 'session-changed' && request.query.sessionId && event.sessionId !== request.query.sessionId) return;
      if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
      if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const close = () => {
      clearInterval(heartbeat);
      index.off('change', send);
      streams.delete(stream);
      if (!response.destroyed) response.end();
    };
    const stream = { close };
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15000);
    heartbeat.unref();
    streams.add(stream);
    index.on('change', send);
    response.on('close', close);
    send({ type: 'ready', progress: index.progress });
  });

  if (options.clientDir) {
    try {
      await access(path.join(options.clientDir, 'index.html'));
      await app.register(fastifyStatic, { root: options.clientDir });
    } catch {
      app.log.warn('前端产物不存在，请先执行 pnpm build 或使用 pnpm dev。');
    }
  }
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ message: '接口不存在。' });
    return reply.code(404).type('text/plain').send('前端尚未构建。开发使用 pnpm dev，生产使用 pnpm build && pnpm start。');
  });
  app.addHook('preClose', async () => { for (const stream of streams) stream.close(); });
  app.addHook('onClose', async () => { await contextAnalysis.stop(); });
  return app;
}
