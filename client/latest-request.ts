import type { RequestUsage } from '../shared/types';

/** Activity order is log order. A trailing cumulative delta cannot identify one model call. */
export function latestRecordedRequest(requests: readonly RequestUsage[], latestInputTokens: number | null): RequestUsage | null {
  const last = requests.at(-1);
  return latestInputTokens != null && last?.source === 'record' && last.usage.inputTokens === latestInputTokens && last.id && last.turnId
    ? last
    : null;
}
