export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function sessionPath(id: string) {
  return `/api/sessions/${encodeURIComponent(id)}`;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '发生了未知错误';
}

export function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}
