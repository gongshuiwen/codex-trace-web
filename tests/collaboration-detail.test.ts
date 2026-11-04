import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineEvent, TurnDetail } from '../shared/types';
import { createCollaborationDetailLoader, type CollaborationLocation } from '../client/collaboration-detail';
import { createTurnDetailCache } from '../client/turn-detail-cache';

function location(overrides: Partial<CollaborationLocation> = {}): CollaborationLocation {
  return { sessionId: 'session', turnId: 'turn', id: 'message-1', messageType: 'MESSAGE', sender: '/root/worker', taskName: '/root', ...overrides };
}

function event(id = 'message-1', payload = '完整正文', overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return { id, kind: 'collaboration', timestamp: '2026-11-03T00:00:00Z', text: '完整原始日志：' + payload,
    collaboration: { messageType: 'MESSAGE', sender: '/root/worker', taskName: '/root', payload }, ...overrides };
}

function detail(events = [event()], turnId = 'turn'): TurnDetail {
  return { summary: { id: turnId, prompt: '', preview: '' }, events, requests: [], warnings: [] } as unknown as TurnDetail;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => vi.unstubAllGlobals());

describe('collaboration full message loading', () => {
  it('reuses only a turn cached at the exact requested revision and keeps empty payloads valid', async () => {
    const cache = createTurnDetailCache();
    const source = event('message-1', '');
    cache.put('session', 'turn', 'current', detail([source]));
    const fetchTurn = vi.fn();
    const load = createCollaborationDetailLoader({ cache, fetchTurn });
    expect(await load(location(), 'current')).toEqual({ payload: '', raw: source.text });
    expect(fetchTurn).not.toHaveBeenCalled();
  });

  it('refreshes a stale revision even when it contains the same event ID', async () => {
    const cache = createTurnDetailCache();
    cache.put('session', 'turn', 'old', detail([event('message-1', '旧正文')]));
    const fetchTurn = vi.fn(async () => detail([event('message-1', '新正文')]));
    const load = createCollaborationDetailLoader({ cache, fetchTurn });
    expect((await load(location(), 'new')).payload).toBe('新正文');
    expect(fetchTurn).toHaveBeenCalledOnce();
    expect(cache.get('session', 'turn')?.revision).toBe('new');
  });

  it('never substitutes another message with the same sender and preview, and can retry a missing event', async () => {
    const cache = createTurnDetailCache();
    const fetchTurn = vi.fn().mockResolvedValueOnce(detail([event('other-message', '同一个预览')]));
    fetchTurn.mockResolvedValueOnce(detail([event('message-1', '同一个预览：正确完整正文')]));
    const load = createCollaborationDetailLoader({ cache, fetchTurn });
    await expect(load(location(), 'current')).rejects.toThrow('未找到这条协作消息');
    expect((await load(location(), 'current')).payload).toBe('同一个预览：正确完整正文');
    expect(fetchTurn).toHaveBeenCalledTimes(2);
  });

  it.each([
    { kind: 'assistant' as const },
    { collaboration: { ...event().collaboration!, sender: '/root/another-worker' } },
    { collaboration: { ...event().collaboration!, taskName: '/root/another-recipient' } },
    { collaboration: { ...event().collaboration!, messageType: 'FINAL_ANSWER' as const } },
  ])('rejects a reused event ID with a different event kind or route: %j', async overrides => {
    const load = createCollaborationDetailLoader({ cache: createTurnDetailCache(), fetchTurn: async () => detail([event('message-1', '正文', overrides)]) });
    await expect(load(location(), 'current')).rejects.toThrow('未找到这条协作消息');
  });

  it('rejects a response from a different turn without caching it', async () => {
    const cache = createTurnDetailCache();
    const load = createCollaborationDetailLoader({ cache, fetchTurn: async () => detail([event()], 'other-turn') });
    await expect(load(location(), 'current')).rejects.toThrow('轮次与消息来源不一致');
    expect(cache.get('session', 'turn')).toBeUndefined();
  });

  it('deduplicates simultaneous requests for different messages in the same turn and revision', async () => {
    const response = deferred<TurnDetail>();
    const fetchTurn = vi.fn(() => response.promise);
    const load = createCollaborationDetailLoader({ cache: createTurnDetailCache(), fetchTurn });
    const first = load(location(), 'current');
    const second = load(location({ id: 'message-2' }), 'current');
    response.resolve(detail([event('message-1', '第一条'), event('message-2', '第二条')]));
    expect((await first).payload).toBe('第一条');
    expect((await second).payload).toBe('第二条');
    expect(fetchTurn).toHaveBeenCalledOnce();
  });

  it('does not share requests across sessions or revisions', async () => {
    const fetchTurn = vi.fn(async () => detail());
    const load = createCollaborationDetailLoader({ cache: createTurnDetailCache(), fetchTurn });
    await Promise.all([load(location(), 'v1'), load(location({ sessionId: 'other-session' }), 'v1'), load(location(), 'v2')]);
    expect(fetchTurn).toHaveBeenCalledTimes(3);
  });

  it('lets one message cancel without aborting another subscriber', async () => {
    const response = deferred<TurnDetail>();
    const fetchTurn = vi.fn((_sessionId: string, _turnId: string, _signal: AbortSignal) => response.promise);
    const load = createCollaborationDetailLoader({ cache: createTurnDetailCache(), fetchTurn });
    const controller = new AbortController();
    const first = load(location(), 'current', controller.signal);
    const second = load(location({ id: 'message-2' }), 'current');
    const cancellation = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await cancellation;
    expect(fetchTurn.mock.calls[0][2].aborted).toBe(false);
    response.resolve(detail([event(), event('message-2', '另一条正文')]));
    expect((await second).payload).toBe('另一条正文');
    expect(fetchTurn).toHaveBeenCalledOnce();
  });

  it('aborts an abandoned request and permits an immediate retry even if the old transport ignores abort', async () => {
    const abandoned = deferred<TurnDetail>();
    const cache = createTurnDetailCache();
    const fetchTurn = vi.fn<(_sessionId: string, _turnId: string, _signal: AbortSignal) => Promise<TurnDetail>>()
      .mockImplementationOnce(() => abandoned.promise).mockResolvedValueOnce(detail([event('message-1', '重试正文')]));
    const load = createCollaborationDetailLoader({ cache, fetchTurn });
    const controller = new AbortController();
    const first = load(location(), 'current', controller.signal);
    const cancellation = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await cancellation;
    expect(fetchTurn.mock.calls[0][2].aborted).toBe(true);
    expect((await load(location(), 'current')).payload).toBe('重试正文');
    abandoned.resolve(detail([event('message-1', '已取消的旧正文')]));
    await Promise.resolve(); await Promise.resolve();
    expect(cache.get('session', 'turn')?.data.events[0].collaboration?.payload).toBe('重试正文');
  });

  it('retries after a transport error and does not retain rejected shared requests', async () => {
    const fetchTurn = vi.fn().mockRejectedValueOnce(new Error('network failed')).mockResolvedValueOnce(detail());
    const load = createCollaborationDetailLoader({ cache: createTurnDetailCache(), fetchTurn });
    await expect(load(location(), 'current')).rejects.toThrow('network failed');
    expect((await load(location(), 'current')).payload).toBe('完整正文');
    expect(fetchTurn).toHaveBeenCalledTimes(2);
  });

  it('does not let a slower old revision overwrite a newer cache result', async () => {
    const older = deferred<TurnDetail>(), newer = deferred<TurnDetail>();
    const cache = createTurnDetailCache();
    const fetchTurn = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const load = createCollaborationDetailLoader({ cache, fetchTurn });
    const oldRequest = load(location(), 'v1');
    const newRequest = load(location(), 'v2');
    newer.resolve(detail([event('message-1', '新正文')]));
    await newRequest;
    older.resolve(detail([event('message-1', '旧正文')]));
    expect((await oldRequest).payload).toBe('旧正文');
    expect(cache.get('session', 'turn')?.revision).toBe('v2');
    expect(cache.get('session', 'turn')?.data.events[0].collaboration?.payload).toBe('新正文');
  });

  it('rejects already cancelled callers without starting a request', async () => {
    const controller = new AbortController(); controller.abort();
    const fetchTurn = vi.fn();
    const load = createCollaborationDetailLoader({ cache: createTurnDetailCache(), fetchTurn });
    await expect(load(location(), 'current', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchTurn).not.toHaveBeenCalled();
  });

  it('uses the existing turn API with independently encoded session and turn IDs', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(detail([event()], 'turn/1')), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const load = createCollaborationDetailLoader({ cache: createTurnDetailCache() });
    await load(location({ sessionId: 'session/1', turnId: 'turn/1' }), 'current');
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session%2F1/turns/turn%2F1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
