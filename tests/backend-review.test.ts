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
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SSE delivery timeout')), 2000); }),
      ]);
      return new TextDecoder().decode(chunk.value);
    } finally { clearTimeout(timer!); }
  };
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const connect = async (sessionId: string) => {
      const controller = new AbortController();
      connections.push(controller);
      const response = await fetch(`${url}/api/events?sessionId=${sessionId}`, { signal: controller.signal });
      const reader = response.body!.getReader();
      readers.push(reader);
      expect(await read(reader)).toContain('"type":"ready"');
      return reader;
    };
    const first = await connect('first');
    const second = await connect('second');
    f.index.emit('change', { type: 'session-changed', sessionId: 'first', revision: 'one' } satisfies LiveEvent);
    f.index.emit('change', { type: 'session-changed', sessionId: 'second', revision: 'two' } satisfies LiveEvent);
    const one = await read(first);
    const two = await read(second);
    expect(one).toContain('"sessionId":"first"');
    expect(one).not.toContain('"sessionId":"second"');
    expect(two).toContain('"sessionId":"second"');
    expect(two).not.toContain('"sessionId":"first"');
    await first.cancel();
    const reconnected = await connect('first');
    f.index.emit('change', { type: 'session-changed', sessionId: 'first', revision: 'three' } satisfies LiveEvent);
    expect(await read(reconnected)).toContain('"revision":"three"');
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
