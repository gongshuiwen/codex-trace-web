import { mkdtemp, mkdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { on } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { IndexService } from '../server/indexer.js';
import type { LiveEvent } from '../shared/types.js';

async function cleanup(root: string): Promise<void> {
  if (!path.resolve(root).startsWith(path.join(tmpdir(), 'session-lens-performance-'))) throw new Error('Unexpected cleanup target');
  await rm(root, { recursive: true, force: true });
}

async function waitForReady(index: IndexService): Promise<void> {
  await expect.poll(() => index.progress.status, { timeout: 20000, interval: 50 }).toBe('ready');
}

function entry(type: string, payload: object): string {
  return JSON.stringify({ type, timestamp: '2026-11-02T01:00:00.000Z', payload }) + '\n';
}

describe('large local rollouts', () => {
  it('keeps HTTP and summary queries responsive during a 24 MiB scan and reuses the persistent index', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-lens-performance-'));
    const sessionsDir = path.join(root, 'sessions');
    const dataDir = path.join(root, 'data');
    await mkdir(sessionsDir);
    const file = await open(path.join(sessionsDir, 'rollout-large.jsonl'), 'w');
    const bodyMarker = 'TOOL_OUTPUT_NOT_A_MESSAGE';
    const chunk = bodyMarker + 'x'.repeat(1024 * 1024);
    try {
      await file.write(entry('session_meta', { id: 'large-session', cwd: '/large-test', timestamp: '2026-11-02T01:00:00.000Z' }));
      await file.write(entry('event_msg', { type: 'task_started', turn_id: 'large-turn' }));
      await file.write(entry('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '大型日志测试：工具正文不进入索引摘要。' }] }));
      for (let i = 0; i < 24; i++) {
        await file.write(entry('response_item', { type: 'function_call', name: 'exec_command', call_id: `call-${i}`, arguments: '{"cmd":"synthetic"}' }));
        await file.write(entry('response_item', { type: 'function_call_output', call_id: `call-${i}`, output: chunk }));
      }
      await file.write(entry('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '大型测试已完成。' }] }));
      await file.write(entry('event_msg', { type: 'task_complete', turn_id: 'large-turn' }));
    } finally { await file.close(); }
    let index = new IndexService({ sessionsDir, dataDir });
    const app = await createApp({ index, settings: { sessionsDir, defaultSessionsDir: sessionsDir, dataDir } });
    const probe = async () => {
      const started = performance.now();
      const [health, initial] = await Promise.all([app.inject('/api/health'), index.list()]);
      return { health, initial, elapsed: performance.now() - started };
    };
    const scanController = new AbortController();
    const scanTimeout = setTimeout(() => scanController.abort(), 15000);
    const duringScan = (async () => {
      for await (const [event] of on(index, 'change', { signal: scanController.signal })) {
        const update = event as LiveEvent;
        if (update.type !== 'index-progress') continue;
        if (update.progress?.status === 'error') throw new Error(update.progress.message || 'Index scan failed');
        if (update.progress?.status !== 'scanning') continue;
        // Launch on the scan-start event. By the time either query returns the
        // Worker may legitimately have completed the scan, especially when the
        // main thread is busy running the rest of the suite.
        return probe();
      }
      throw new Error('Index scan ended without a scanning event');
    })();
    try {
      const [, { health, initial, elapsed }] = await Promise.all([index.start(), duringScan]);
      expect(health.statusCode).toBe(200);
      expect(elapsed).toBeLessThan(2000);
      expect(initial.progress.errors).toBe(0);
      await waitForReady(index);
      const result = await index.list({ query: '大型日志' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].toolCount).toBe(24);
      expect(JSON.stringify(result).length).toBeLessThan(10000);
      expect(JSON.stringify(result)).not.toContain(bodyMarker);
      expect((await index.list({ query: bodyMarker })).total).toBe(0);
      const detail = await index.get('large-session');
      expect(detail?.turns).toHaveLength(1);
      expect(JSON.stringify(detail).length).toBeLessThan(10000);
      expect(JSON.stringify(detail)).not.toContain(bodyMarker);
      await index.stop();

      // The second Worker starts with an empty parser-process cache. An unchanged
      // file must still avoid reparsing through the persisted size/mtime index.
      index = new IndexService({ sessionsDir, dataDir });
      const reparsed: string[] = [];
      index.on('change', event => { if (event.type === 'session-changed') reparsed.push(event.sessionId); });
      await index.start();
      const cached = await index.list();
      expect(cached.items[0]?.id).toBe('large-session');
      await waitForReady(index);
      expect(reparsed).toEqual([]);
    } finally {
      clearTimeout(scanTimeout);
      scanController.abort();
      await app.close(); await index.stop(); await cleanup(root);
    }
  }, 30000);
});
