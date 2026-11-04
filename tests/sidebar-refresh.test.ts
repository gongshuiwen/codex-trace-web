import { describe, expect, it } from 'vitest';
import type { SessionList, SessionSummary } from '../shared/types';
import { beginBranchLoad, branchControls, sidebarListRevision, sidebarRowNeedsReveal, type SidebarBranch } from '../client/sidebar-refresh';

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id, title: id, cwd: '/project', project: 'project', model: 'model', source: 'cli',
    startedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', status: 'completed',
    turnCount: 1, toolCount: 0, childCount: 1, filePath: `${id}.jsonl`, fileSize: 100, revision: '1', parseErrors: 0,
    usage: { tokens: null, requestCount: 0, completeness: 'unknown', latestInputTokens: null, contextWindow: null }, ...overrides,
  };
}
function list(items: SessionSummary[], extra: Partial<SessionList> = {}): SessionList {
  return { items, total: items.length, nextCursor: null, projects: [], progress: { status: 'ready', discovered: items.length, indexed: items.length, errors: 0 }, ...extra };
}
function cached(): SidebarBranch {
  return { items: [session('child')], total: 80, nextCursor: 50, loaded: true, loading: null, error: '' };
}

describe('sidebar branch refresh stability', () => {
  it('does not invalidate cached branches when selection changes or summary objects are recreated', () => {
    const before = list([session('root')], { selected: session('first'), ancestors: [session('first-parent')] });
    const selected = list([session('root')], { selected: session('second'), ancestors: [session('second-parent')] });
    expect(sidebarListRevision(selected)).toBe(sidebarListRevision(before));
  });

  it('invalidates for actual archive revisions, direct-child count changes and page growth', () => {
    const before = sidebarListRevision(list([session('root')]));
    expect(sidebarListRevision(list([session('root', { revision: '2' })]))).not.toBe(before);
    expect(sidebarListRevision(list([session('root', { childCount: 2 })]))).not.toBe(before);
    expect(sidebarListRevision(list([session('root'), session('next')]))).not.toBe(before);
  });

  it('keeps cached children and the existing pagination row during background revalidation', () => {
    const previous = cached();
    const refreshing = beginBranchLoad(previous, 'refresh');
    expect(refreshing.items).toBe(previous.items);
    expect(refreshing.nextCursor).toBe(previous.nextCursor);
    expect(branchControls(refreshing)).toEqual({ initialLoading: false, error: false, more: true, paging: false });
    expect(branchControls({ ...refreshing, loading: null, error: 'offline' })).toEqual({ initialLoading: false, error: false, more: true, paging: false });
  });

  it('keeps the same pagination slot while appending another page', () => {
    const previous = cached();
    const paging = beginBranchLoad(previous, 'more');
    expect(paging.items).toBe(previous.items);
    expect(paging.total).toBe(80);
    expect(branchControls(paging)).toEqual({ initialLoading: false, error: false, more: true, paging: true });
    expect(branchControls(previous).more).toBe(true);
  });

  it('shows loading and retry guidance for a branch with no successful response yet', () => {
    const initial = beginBranchLoad(undefined, 'initial');
    expect(branchControls(initial)).toEqual({ initialLoading: true, error: false, more: false, paging: false });
    const failed = { ...initial, loading: null, error: 'offline' };
    expect(branchControls(failed).error).toBe(true);
    expect(branchControls(beginBranchLoad(failed, 'refresh')).initialLoading).toBe(true);
  });

  it('keeps an already visible selection stationary and reveals rows outside the usable scroll viewport', () => {
    const viewport = { top: 100, bottom: 600 };
    expect(sidebarRowNeedsReveal({ top: 150, bottom: 210 }, viewport, 36, 8)).toBe(false);
    expect(sidebarRowNeedsReveal({ top: 50, bottom: 110 }, viewport, 36, 8)).toBe(true);
    expect(sidebarRowNeedsReveal({ top: 560, bottom: 620 }, viewport, 36, 8)).toBe(true);
  });

  it('treats a row covered by a sticky date or scroll padding as outside while tolerating pixel rounding', () => {
    const viewport = { top: 100, bottom: 600 };
    expect(sidebarRowNeedsReveal({ top: 140, bottom: 200 }, viewport, 36, 8, 148)).toBe(true);
    expect(sidebarRowNeedsReveal({ top: 130, bottom: 190 }, viewport, 36, 8, 132)).toBe(true);
    expect(sidebarRowNeedsReveal({ top: 135.5, bottom: 592.5 }, viewport, 36, 8)).toBe(false);
  });
});
