import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../client/api';

afterEach(() => { vi.unstubAllGlobals(); });

describe('client HTTP API', () => {
  it('surfaces the backend message when a request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: '未找到此轮次。' }), { status: 404 })));

    await expect(api('/api/sessions/session/turns/missing')).rejects.toThrow('未找到此轮次。');
  });

  it.each([
    { name: 'non-JSON response', body: '<html>Bad Gateway</html>' },
    { name: 'null response', body: 'null' },
    { name: 'missing message', body: '{}' },
    { name: 'non-string message', body: JSON.stringify({ message: { detail: 'unavailable' } }) },
    { name: 'empty message', body: JSON.stringify({ message: '' }) },
    { name: 'blank message', body: JSON.stringify({ message: '   ' }) },
  ])('uses an HTTP status fallback for a $name', async ({ body }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 503 })));

    await expect(api('/api/settings')).rejects.toThrow('请求失败 (503)');
  });

  it('returns successful JSON unchanged', async () => {
    const payload = { items: [], total: 0, nextCursor: null };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));

    await expect(api('/api/sessions')).resolves.toEqual(payload);
  });

  it('preserves abort errors for caller cancellation handling', async () => {
    const error = new DOMException('Request cancelled', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));

    await expect(api('/api/sessions')).rejects.toBe(error);
  });
});
