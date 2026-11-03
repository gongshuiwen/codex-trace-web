import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCollaborationMessage } from '../server/collaboration.js';
import { indexSessionFile, loadSessionActivity, loadTurnDetail } from '../server/parser.js';

const directories: string[] = [];
const header = (type = 'MESSAGE', body = '') => `Message Type: ${type}\nTask name: /root\nSender: /root/worker\nPayload:\n${body}`;
const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type, payload });

async function detail(records: string[]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'session-lens-collaboration-'));
  directories.push(directory);
  const location = path.join(directory, 'rollout-test.jsonl');
  await writeFile(location, [
    line('session_meta', { id: 'collaboration-test', cwd: '/demo' }),
    line('event_msg', { type: 'task_started', turn_id: 't1' }),
    ...records,
    line('event_msg', { type: 'task_complete', turn_id: 't1' }),
  ].join('\n') + '\n');
  return { location, turn: await loadTurnDetail(location, 't1'), index: await indexSessionFile(location) };
}

afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('collaboration messages', () => {
  it('renders empty NEW_TASK envelopes as collaboration in both timeline and activity', async () => {
    const text = 'Message Type: NEW_TASK\nTask name: /root/review_worker\nSender: /root\nPayload:';
    const { location, turn, index } = await detail([
      line('response_item', { type: 'message', role: 'user', content: 'review files' }),
      line('response_item', { type: 'agent_message', content: [{ type: 'input_text', text }] }),
    ]);
    expect(turn.events[1]).toMatchObject({ kind: 'collaboration', text, collaboration: { messageType: 'NEW_TASK', taskName: '/root/review_worker', sender: '/root', payload: '' } });
    expect(turn.events.some(event => event.kind === 'notice')).toBe(false);
    expect((await loadSessionActivity(location)).messages).toEqual([expect.objectContaining({ messageType: 'NEW_TASK', turnId: 't1', sender: '/root', taskName: '/root/review_worker', preview: '' })]);
    expect(index.searchMessages.map(message => message.text)).not.toContain(text);
  });

  it('preserves Markdown and payload text that resembles another protocol header', () => {
    const payload = '## Result\n\n- `pnpm build` passed\n- Keep this list\n\nSender: mentioned in the body\nPayload:\ntrailing text\n';
    expect(parseCollaborationMessage(header('FINAL_ANSWER', payload))).toEqual({ messageType: 'FINAL_ANSWER', taskName: '/root', sender: '/root/worker', payload });
  });

  it('accepts CRLF headers and empty or inline payloads', () => {
    expect(parseCollaborationMessage(header().replaceAll('\n', '\r\n'))?.payload).toBe('');
    expect(parseCollaborationMessage(header('MESSAGE', 'inline').replace('Payload:\n', 'Payload: '))?.payload).toBe('inline');
    expect(parseCollaborationMessage(header('MESSAGE', '中文\n第二行').replaceAll('\n', '\r\n'))?.payload).toBe('中文\r\n第二行');
  });

  it('rejects incomplete, unknown and quoted envelopes', () => {
    for (const text of [header('UNKNOWN'), header().replace('Sender: /root/worker\n', ''), header().replace('/root/worker', ''), `User quoted:\n${header()}`, header().replace('Task name: /root', 'Task name: invalid name')]) {
      expect(parseCollaborationMessage(text)).toBeNull();
    }
  });

  it('classifies dedicated agent records and preserves repeated empty messages in order', async () => {
    const empty = header();
    const final = header('FINAL_ANSWER', '- Done\n- Verified');
    const { turn, index } = await detail([
      line('response_item', { type: 'message', role: 'user', content: 'run' }),
      line('response_item', { type: 'agent_message', content: empty }),
      line('response_item', { type: 'agent_message', content: empty }),
      line('agent_message', { content: [{ type: 'text', text: final }] }),
    ]);
    const messages = turn.events.filter(event => event.kind === 'collaboration');
    expect(messages.map(event => event.collaboration?.messageType)).toEqual(['MESSAGE', 'MESSAGE', 'FINAL_ANSWER']);
    expect(messages[0]?.text).toBe(empty);
    expect(messages[0]?.collaboration?.payload).toBe('');
    expect(messages[0]?.id).not.toBe(messages[1]?.id);
    expect(messages[2]?.collaboration?.payload).toBe('- Done\n- Verified');
    expect(turn.events.some(event => event.kind === 'notice')).toBe(false);
    expect(index.turns).toHaveLength(1);
    expect(index.turns[0]?.prompt).toBe('run');
    expect(index.session.usage.requestCount).toBe(0);
  });

  it.each(['FINAL_ANSWER', 'NEW_TASK'])('keeps %s user quotes, assistant responses, CLI agent messages and real warnings in their original categories', async type => {
    const quoted = header(type, 'This is quoted prose');
    const { turn } = await detail([
      line('response_item', { type: 'message', role: 'user', content: quoted }),
      line('response_item', { type: 'message', role: 'assistant', content: quoted }),
      line('event_msg', { type: 'agent_message', phase: 'commentary', message: quoted }),
      line('event_msg', { type: 'warning', message: quoted }),
      line('response_item', { type: 'agent_message', content: 'An unrecognized agent record' }),
      line('response_item', { type: 'agent_message', content: header('UNKNOWN', 'Future envelope') }),
    ]);
    expect(turn.events.map(event => event.kind)).toEqual(['user', 'assistant', 'commentary', 'notice', 'notice', 'notice']);
    expect(turn.events.every(event => event.collaboration === undefined)).toBe(true);
    expect(turn.events[4]?.text).toBe('An unrecognized agent record');
  });
});
