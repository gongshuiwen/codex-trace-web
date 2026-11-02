import type { RequestUsage, TokenUsage, UsageSummary } from '../shared/types.js';

type Json = Record<string, any>;
const fields: (keyof TokenUsage)[] = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;

export function zeroUsage(): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

export function normalizeUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Json;
  if (!['input_tokens', 'output_tokens', 'total_tokens', 'inputTokens', 'outputTokens', 'totalTokens'].some(key => typeof raw[key] === 'number')) return null;
  const inputTokens = numeric(raw.input_tokens ?? raw.inputTokens);
  const outputTokens = numeric(raw.output_tokens ?? raw.outputTokens);
  return {
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, numeric(raw.cached_input_tokens ?? raw.cachedInputTokens ?? raw.input_tokens_details?.cached_tokens)),
    cacheWriteInputTokens: Math.min(inputTokens, numeric(raw.cache_write_input_tokens ?? raw.cacheWriteInputTokens)),
    outputTokens,
    reasoningOutputTokens: Math.min(outputTokens, numeric(raw.reasoning_output_tokens ?? raw.reasoningOutputTokens ?? raw.output_tokens_details?.reasoning_tokens)),
    totalTokens: typeof (raw.total_tokens ?? raw.totalTokens) === 'number' ? numeric(raw.total_tokens ?? raw.totalTokens) : inputTokens + outputTokens,
  };
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const result = zeroUsage();
  for (const field of fields) result[field] = left[field] + right[field];
  return result;
}

function difference(current: TokenUsage, previous: TokenUsage): TokenUsage {
  const result = zeroUsage();
  for (const field of fields) result[field] = Math.max(0, current[field] - previous[field]);
  result.cachedInputTokens = Math.min(result.inputTokens, result.cachedInputTokens);
  result.cacheWriteInputTokens = Math.min(result.inputTokens, result.cacheWriteInputTokens);
  result.reasoningOutputTokens = Math.min(result.outputTokens, result.reasoningOutputTokens);
  return result;
}

interface UsageRecord extends RequestUsage { sequence: number; cumulative: TokenUsage | null; }
interface Snapshot {
  sequence: number;
  turnId: string;
  timestamp: string;
  cumulative: TokenUsage;
  latest: TokenUsage | null;
  model?: string;
  contextWindow?: number;
}

/** Keeps usage metadata only; never stores transcript or tool payloads. */
export class UsageLedger {
  private records = new Map<string, UsageRecord>();
  private snapshots: Snapshot[] = [];
  private contextWindows = new Map<string, number>();
  private resolved: { requests: RequestUsage[]; partial: boolean } | null = null;

  setContextWindow(turnId: string, value: unknown): void {
    if (typeof value === 'number' && value > 0) { this.contextWindows.set(turnId, value); this.resolved = null; }
  }

  ingest(type: string, payload: Json, turnId: string, timestamp: string, sequence: number, model?: string): void {
    if (type === 'token_usage_record') {
      const usage = normalizeUsage(payload.usage);
      if (!usage) return;
      const id = String(payload.response_id || `record-${sequence}`);
      if (this.records.has(id)) return;
      const actualTurnId = String(payload.turn_id || turnId);
      this.records.set(id, {
        id, turnId: actualTurnId, timestamp, usage, sequence, model,
        source: 'record', contextWindow: this.contextWindows.get(actualTurnId),
        cumulative: normalizeUsage(payload.thread_token_usage),
      });
      this.resolved = null;
    }
    if (type === 'event_msg' && payload.type === 'token_count' && payload.info) {
      const info = payload.info;
      this.setContextWindow(turnId, info.model_context_window);
      const cumulative = normalizeUsage(info.total_token_usage);
      if (cumulative) this.snapshots.push({
        sequence, turnId, timestamp, cumulative, latest: normalizeUsage(info.last_token_usage), model,
        contextWindow: this.contextWindows.get(turnId),
      });
      this.resolved = null;
    }
  }

  private resolve(): { requests: RequestUsage[]; partial: boolean } {
    if (this.resolved) return this.resolved;
    const records = [...this.records.values()];
    const requests: RequestUsage[] = records.map(({ sequence: _sequence, cumulative: _cumulative, ...request }) => ({
      ...request, contextWindow: request.contextWindow ?? this.contextWindows.get(request.turnId),
    }));
    let previous = zeroUsage();
    let previousSequence = -1;
    let epoch = 0;
    let partial = false;
    const intervals = this.snapshots.map(snapshot => {
      if (snapshot.cumulative.totalTokens < previous.totalTokens) {
        previous = zeroUsage();
        epoch++;
        partial = true;
      }
      const interval = { snapshot, previous, previousSequence, epoch, delta: difference(snapshot.cumulative, previous) };
      previous = snapshot.cumulative;
      previousSequence = snapshot.sequence;
      return interval;
    });

    // Assign each direct record to one cumulative interval. Matching cumulative totals
    // also deduplicates a token_count which was written before its usage record.
    const covered = new Map<number, TokenUsage>();
    for (const record of records) {
      const nearest = intervals.find(interval => interval.snapshot.sequence >= record.sequence) ?? intervals.at(-1);
      const recordEpoch = nearest?.epoch ?? 0;
      let intervalIndex = intervals.findIndex(interval => interval.epoch === recordEpoch && record.cumulative
        && record.cumulative.totalTokens > interval.previous.totalTokens
        && record.cumulative.totalTokens <= interval.snapshot.cumulative.totalTokens);
      if (intervalIndex < 0 && !record.cumulative) intervalIndex = intervals.findIndex(interval => record.sequence > interval.previousSequence && record.sequence <= interval.snapshot.sequence);
      if (intervalIndex >= 0) covered.set(intervalIndex, addUsage(covered.get(intervalIndex) ?? zeroUsage(), record.usage));
    }

    intervals.forEach((interval, index) => {
      const usage = difference(interval.delta, covered.get(index) ?? zeroUsage());
      if (usage.totalTokens <= 0 && usage.inputTokens <= 0 && usage.outputTokens <= 0) return;
      partial = true; // A delta can cover more than one model call; never claim complete tracing.
      const snapshot = interval.snapshot;
      requests.push({
        id: `snapshot-${snapshot.sequence}`, turnId: snapshot.turnId, timestamp: snapshot.timestamp,
        usage, source: 'snapshot-delta', model: snapshot.model, contextWindow: snapshot.contextWindow,
      });
    });
    this.resolved = { requests: requests.sort((left, right) => left.timestamp.localeCompare(right.timestamp)), partial };
    return this.resolved;
  }

  requestsForTurn(turnId: string): RequestUsage[] {
    return this.resolve().requests.filter(request => request.turnId === turnId);
  }

  summary(turnId?: string): UsageSummary {
    const { requests: all, partial } = this.resolve();
    const requests = turnId ? all.filter(request => request.turnId === turnId) : all;
    const snapshots = turnId ? this.snapshots.filter(snapshot => snapshot.turnId === turnId) : this.snapshots;
    const latestRequest = requests.at(-1);
    const latestSnapshot = snapshots.at(-1);
    const latestInputTokens = latestSnapshot?.latest && (!latestRequest || latestSnapshot.timestamp >= latestRequest.timestamp)
      ? latestSnapshot.latest.inputTokens : latestRequest?.usage.inputTokens ?? null;
    return {
      tokens: requests.length ? requests.reduce((total, request) => addUsage(total, request.usage), zeroUsage()) : null,
      requestCount: requests.length,
      completeness: !requests.length ? 'unknown' : requests.some(request => request.source !== 'record') || (!turnId && partial) ? 'partial' : 'complete',
      latestInputTokens,
      contextWindow: latestSnapshot?.contextWindow ?? latestRequest?.contextWindow ?? (turnId ? this.contextWindows.get(turnId) : [...this.contextWindows.values()].at(-1)) ?? null,
    };
  }
}
