import type { UsageSummary } from '../shared/types';

/** The two values must describe the same recorded call; missing input is distinct from zero. */
export function latestInputWindowPercent(usage: Pick<UsageSummary, 'latestInputTokens' | 'contextWindow'>): number | null {
  const { latestInputTokens: input, contextWindow: window } = usage;
  if (input == null || window == null || !Number.isFinite(input) || !Number.isFinite(window) || input < 0 || window <= 0) return null;
  const percent = input / window * 100;
  return Number.isFinite(percent) ? percent : null;
}

/** A recorded span, including pauses; never inferred from the file's modification time. */
export function sessionDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0秒';
  const seconds = Math.floor(value / 1000);
  if (seconds === 0) return '<1秒';
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}时${Math.floor(seconds / 60) % 60}分`;
  return `${Math.floor(seconds / 86400).toLocaleString('zh-CN')}天${Math.floor(seconds / 3600) % 24}时`;
}
