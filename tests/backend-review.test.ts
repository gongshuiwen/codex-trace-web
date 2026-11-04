import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { IndexService } from '../server/indexer.js';
import type { LiveEvent } from '../shared/types.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'session-lens-review-'));
  const sessionsDir = path.join(root, 'sessions');
  const nextDir = path.join(root, 'next');
  const dataDir = path.join(root, 'data');
  await mkdir(sessionsDir);
  await mkdir(nextDir);
  const index = new IndexService({ sessionsDir, dataDir });
  await index.start();
  const settings = { sessionsDir, defaultSessionsDir: sessionsDir, dataDir };
  const cleanup = async () => {
    await index.stop();
    if (!path.resolve(root).startsWith(path.join(tmpdir(), 'session-lens-review-'))) throw new Error('Unexpected cleanup target');
    await rm(root, { recursive: true, force: true });
  };
  return { root, sessionsDir, nextDir, dataDir, index, settings, cleanup };
}

it('rolls back settings and index directory when saving settings fails', async () => {
  const f = await fixture();
  const app = await createApp({ index: f.index, settings: f.settings, saveSettings: async () => { throw new Error('disk full'); } });
  try {
    const response = await app.inject({ method: 'PUT', url: '/api/settings', payload: { sessionsDir: f.nextDir } });
    expect(response.statusCode).toBe(500);
    expect(f.index.sessionsDir).toBe(f.sessionsDir);
    expect((await app.inject('/api/settings')).json().sessionsDir).toBe(f.sessionsDir);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  } finally { await app.close(); await f.cleanup(); }
});

it('rolls back an index transition that fails before settings persistence', async () => {
  const f = await fixture();
  const implementation = f.index.setDirectory.bind(f.index);
  const transition = vi.spyOn(f.index, 'setDirectory');
  transition.mockImplementationOnce(async directory => {
    f.index.sessionsDir = directory;
    throw new Error('synthetic worker startup failure');
  }).mockImplementation(implementation);
  const saveSettings = vi.fn(async () => {});
  const app = await createApp({ index: f.index, settings: f.settings, saveSettings });
  try {
    const response = await app.inject({ method: 'PUT', url: '/api/settings', payload: { sessionsDir: f.nextDir } });
    expect(response.statusCode).toBe(500);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledTimes(2);
    expect(f.index.sessionsDir).toBe(f.sessionsDir);
    expect((await app.inject('/api/settings')).json().sessionsDir).toBe(f.sessionsDir);
  } finally { transition.mockRestore(); await app.close(); await f.cleanup(); }
});

it('keeps independent SSE subscriptions and sends a fresh ready state on reconnect', async () => {
  const f = await fixture();
  const app = await createApp({ index: f.index, settings: f.settings });
  const connections: AbortController[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  type Subscription = { reader: ReadableStreamDefaultReader<Uint8Array>; sessionId: string; decoder: TextDecoder; buffer: string };
  const readEvent = async (subscription: Subscription, deadline = Date.now() + 2000): Promise<LiveEvent> => {
    while (true) {
      const separator = /\r?\n\r?\n/.exec(subscription.buffer);
      if (separator) {
        const frame = subscription.buffer.slice(0, separator.index);
        subscription.buffer = subscription.buffer.slice(separator.index + separator[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, ''));
        if (data.length) return JSON.parse(data.join('\n')) as LiveEvent;
        continue; // Heartbeats are SSE comments, not application events.
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('SSE delivery timeout');
        const chunk = await Promise.race([
          subscription.reader.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SSE delivery timeout')), remaining); }),
        ]);
        if (chunk.done) throw new Error('SSE stream ended before the expected event');
        subscription.buffer += subscription.decoder.decode(chunk.value, { stream: true });
      } finally { clearTimeout(timer); }
    }
  };
  const readUntil = async (subscription: Subscription, matches: (event: LiveEvent) => boolean) => {
    const deadline = Date.now() + 2000;
    const events: LiveEvent[] = [];
    while (true) {
      const event = await readEvent(subscription, deadline);
      // Global index events may arrive between session events. Never skip a
      // leaked foreign session event while waiting for the requested one.
      if (event.type === 'session-changed') expect(event.sessionId).toBe(subscription.sessionId);
      events.push(event);
      if (matches(event)) return events;
    }
  };
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const connect = async (sessionId: string) => {
      const controller = new AbortController();
      connections.push(controller);
      const response = await fetch(`${url}/api/events?sessionId=${sessionId}`, { signal: controller.signal });
      const reader = response.body!.getReader();
      readers.push(reader);
      const subscription: Subscription = { reader, sessionId, decoder: new TextDecoder(), buffer: '' };
      expect(await readEvent(subscription)).toMatchObject({ type: 'ready', progress: expect.any(Object) });
      return subscription;
    };
    const first = await connect('first');
    const second = await connect('second');
    f.index.emit('change', { type: 'session-changed', sessionId: 'first', revision: 'one' } satisfies LiveEvent);
    f.index.emit('change', { type: 'session-changed', sessionId: 'second', revision: 'two' } satisfies LiveEvent);
    // A shared boundary guarantees both streams have consumed the complete
    // emitted interval, even when a foreign event would arrive in a later chunk.
    const boundary = { type: 'sessions-changed', progress: { ...f.index.progress, message: 'SSE subscription boundary' } } satisfies LiveEvent;
    f.index.emit('change', boundary);
    const atBoundary = (event: LiveEvent) => event.type === 'sessions-changed' && event.progress?.message === boundary.progress.message;
    const one = await readUntil(first, atBoundary);
    const two = await readUntil(second, atBoundary);
    expect(one).toContainEqual({ type: 'session-changed', sessionId: 'first', revision: 'one' });
    expect(one).not.toContainEqual(expect.objectContaining({ sessionId: 'second' }));
    expect(two).toContainEqual({ type: 'session-changed', sessionId: 'second', revision: 'two' });
    expect(two).not.toContainEqual(expect.objectContaining({ sessionId: 'first' }));
    await first.reader.cancel();
    const reconnected = await connect('first');
    f.index.emit('change', { type: 'session-changed', sessionId: 'first', revision: 'three' } satisfies LiveEvent);
    expect(await readUntil(reconnected, event => event.type === 'session-changed' && event.revision === 'three'))
      .toContainEqual({ type: 'session-changed', sessionId: 'first', revision: 'three' });
  } finally {
    for (const controller of connections) controller.abort();
    await Promise.allSettled(readers.map(reader => reader.cancel()));
    await app.close();
    await f.cleanup();
  }
}, 15000);

it('does not interpret session IDs as arbitrary local paths', async () => {
  const f = await fixture();
  const app = await createApp({ index: f.index, settings: f.settings });
  try {
    const outside = path.join(f.root, 'outside.jsonl');
    await writeFile(outside, 'private outside data');
    const getPath = vi.spyOn(f.index, 'getPath').mockResolvedValue(outside);
    try {
      expect((await app.inject('/api/sessions/fake/turns/anything')).statusCode).toBe(403);
    } finally { getPath.mockRestore(); }
    expect((await app.inject('/api/sessions/' + encodeURIComponent('../outside.jsonl') + '/turns/anything')).statusCode).toBe(404);
  } finally { await app.close(); await f.cleanup(); }
});
