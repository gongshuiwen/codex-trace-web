export function tokens(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString('zh-CN');
}

export function exactTokens(value: number | null | undefined): string {
  return value == null ? '未记录' : value.toLocaleString('zh-CN');
}

export function clock(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function dateGroup(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日期未知';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return '今天';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export const statusLabels = { running: '进行中', completed: '已完成', interrupted: '已中断', unknown: '未标记', failed: '失败' };

export function prettyArguments(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}
