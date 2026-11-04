import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSessionActivity } from '../server/parser.js';
import { IndexService } from '../server/indexer.js';
import { createApp } from '../server/app.js';
import type { SessionActivity } from '../shared/types.js';

const roots: string[] = [];
const stamp = '2026-01-01T00:00:00Z';
const row = (type: string, payload: object) => ({ type, timestamp: stamp, payload });
const meta = (id = 'activity-test') => row('session_meta', { id, timestamp: stamp, cwd: '/synthetic' });
const start = (turn = 't1') => row('event_msg', { type: 'task_started', turn_id: turn });
const end = (turn = 't1') => row('event_msg', { type: 'task_complete', turn_id: turn });
const message = (role: string, text: string) => row('response_item', { type: 'message', role, content: [{ type: 'input_text', text }] });
const usage = { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, total_tokens: 110 };
const record = (id: string, turnId = 't1') => row('token_usage_record', { response_id: id, turn_id: turnId, usage });
const protocol = (payload = 'worker preview', type = 'MESSAGE') => `Message Type: ${type}\nTask name: /root\nSender: /root/worker\nPayload:\n${payload}`;
const agent = (text: string) => row('response_item', { type: 'agent_message', content: [{ type: 'input_text', text }] });

async function fixture(rows: unknown[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'session-lens-activity-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  await mkdir(sessionsDir);
  const file = path.join(sessionsDir, 'rollout-test.jsonl');
  await writeFile(file, rows.map(value => JSON.stringify(value)).join('\n') + '\n');
  return { root, file, sessionsDir, dataDir: path.join(root, 'data') };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(tmpdir(), 'session-lens-activity-'))) throw new Error('Unexpected cleanup target');
    await rm(root, { recursive: true, force: true });
  }
});

describe('lightweight session activity', () => {
  it('keeps request and compaction positions in log order even when timestamps are equal', async () => {
    const { file } = await fixture([meta(), start(), message('user', 'question'),
      record('r1'), row('compacted', { message: 'not returned compacted body' }), record('r2'), end(),
      start('t2'), record('r3', 't2'), row('compacted', {}), end('t2')]);
    const activity = await loadSessionActivity(file);
    expect(activity.requests.map(request => [request.id, request.turnId])).toEqual([['r1', 't1'], ['r2', 't1'], ['r3', 't2']]);
    expect(activity.compactions.map(marker => [marker.beforeRequestIndex, marker.turnId])).toEqual([[1, 't1'], [3, 't2']]);
    expect(activity.compactions.every(marker => marker.id.startsWith('notice-') && marker.timestamp === stamp)).toBe(true);
    expect(JSON.stringify(activity)).not.toContain('not returned compacted body');
  });

  it('only includes true collaboration records, bounds previews and updates appended markers once', async () => {
    const { file } = await fixture([meta(), start(),
      message('user', protocol('user prose should not become collaboration')),
      message('assistant', protocol('assistant prose should not become collaboration')),
      row('event_msg', { type: 'agent_message', message: protocol('ordinary CLI reply is not a collaboration record') }),
      agent(protocol('x'.repeat(300) + 'DO_NOT_EXPOSE_TAIL')),
      agent(protocol('final preview', 'FINAL_ANSWER')), agent('non-protocol agent content'), record('r1'), end()]);
    const first = await loadSessionActivity(file);
    expect(first.messages).toHaveLength(2);
    expect(first.messages[0]).toMatchObject({ turnId: 't1', sender: '/root/worker', taskName: '/root', messageType: 'MESSAGE' });
    expect(first.messages[0].preview.length).toBeLessThanOrEqual(200);
    expect(first.messages[1]).toMatchObject({ messageType: 'FINAL_ANSWER', preview: 'final preview' });
    expect(JSON.stringify(first)).not.toContain('DO_NOT_EXPOSE_TAIL');
    expect(JSON.stringify(first)).not.toContain('user prose');
    await appendFile(file, JSON.stringify(row('compacted', {})) + '\n');
    const second = await loadSessionActivity(file);
    expect(second.compactions).toHaveLength(1);
    expect(second.compactions[0].beforeRequestIndex).toBe(1);
    expect((await loadSessionActivity(file)).messages).toHaveLength(2);
    expect((await loadSessionActivity(file)).compactions).toHaveLength(1);
  });

  it('excludes child replay and clearly marks unassigned compaction and snapshot-delta usage', async () => {
    const rows = [row('session_meta', { id: 'child', subagent_history_start_ordinal: 5 }),
      start('parent'), agent(protocol('inherited worker message')), record('parent', 'parent'), row('compacted', {}),
      row('compacted', {}), start('child-turn'), agent(protocol('own message')),
      row('event_msg', { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } }), end('child-turn'),
    ].map((value, ordinal) => ({ ...value, ordinal }));
    const { file } = await fixture(rows);
    const activity = await loadSessionActivity(file);
    expect(activity.compactions).toHaveLength(1);
    expect(activity.compactions[0]).toMatchObject({ beforeRequestIndex: 0 });
    expect(activity.compactions[0].turnId).toBeUndefined();
    expect(activity.messages.map(item => item.preview)).toEqual(['own message']);
    expect(activity.requests).toHaveLength(1);
    expect(activity.requests[0].source).toBe('snapshot-delta');
    expect(activity.warnings.some(warning => warning.includes('快照差值'))).toBe(true);
    expect(activity.warnings.some(warning => warning.includes('轮次归属'))).toBe(true);
    expect(activity.warnings.some(warning => warning.includes('继承'))).toBe(true);
  });

  it('serves activity in the existing worker without copying tool bodies or accepting local file paths', async () => {
    const { file, sessionsDir, dataDir } = await fixture([meta(), start(), message('user', 'small prompt'),
      row('response_item', { type: 'function_call', call_id: 'large', name: 'exec', arguments: 'not activity content' }),
      row('response_item', { type: 'function_call_output', call_id: 'large', output: 'PRIVATE_TOOL_BODY'.repeat(60000) }),
      record('r1'), agent(protocol('brief update')), row('compacted', {}), end()]);
    const index = new IndexService({ sessionsDir, dataDir });
    const app = await createApp({ index, settings: { sessionsDir, dataDir, defaultSessionsDir: sessionsDir } });
    try {
      await index.start();
      await expect.poll(async () => (await index.list()).total).toBe(1);
      const response = await app.inject('/api/sessions/activity-test/activity');
      expect(response.statusCode).toBe(200);
      const activity = response.json<SessionActivity>();
      expect(activity.messages[0].preview).toBe('brief update');
      expect(activity.compactions[0].beforeRequestIndex).toBe(1);
      expect(response.body.length).toBeLessThan(4000);
      expect(response.body).not.toContain('PRIVATE_TOOL_BODY');
      expect(response.body).not.toContain('small prompt');
      expect((await app.inject('/api/sessions/missing/activity')).statusCode).toBe(404);
      expect((await app.inject('/api/sessions/' + encodeURIComponent(file) + '/activity')).statusCode).toBe(404);
      expect((await app.inject('/api/health')).statusCode).toBe(200);
    } finally { await app.close(); await index.stop(); }
  });

  it('does not silently truncate sessions with more than ten thousand lightweight calls', async () => {
    const { file } = await fixture([meta(), start(), ...Array.from({ length: 10001 }, (_, index) => record(`r${index}`)), row('compacted', {}), end()]);
    const activity = await loadSessionActivity(file);
    expect(activity.requests).toHaveLength(10001);
    expect(activity.compactions[0].beforeRequestIndex).toBe(10001);
    expect(activity.requests.at(-1)?.id).toBe('r10000');
  }, 20000);
});
