import type { SessionChildrenPage, SessionList } from '../shared/types';

export type BranchLoadMode = 'initial' | 'refresh' | 'more';
export interface SidebarBranch extends SessionChildrenPage {
  loaded: boolean;
  loading: BranchLoadMode | null;
  error: string;
}

/** Selection adds ancestors and replaces object identities without invalidating the archive page. */
export function sidebarListRevision(data: SessionList | null): string {
  return JSON.stringify(data && [data.total, data.nextCursor, data.items.map(session =>
    [session.id, session.revision, session.parentId, session.childCount])]);
}

export function beginBranchLoad(previous: SidebarBranch | undefined, mode: BranchLoadMode): SidebarBranch {
  return { ...(previous ?? { items: [], total: 0, nextCursor: null, loaded: false }), loading: mode, error: '' };
}

/** A background check never adds a status row or replaces an existing paging row. */
export function branchControls(branch: SidebarBranch | undefined) {
  return {
    initialLoading: Boolean(branch?.loading && !branch.loaded),
    error: Boolean(branch?.error && !branch.loaded),
    more: Boolean(branch?.loaded && branch.nextCursor != null),
    paging: branch?.loading === 'more',
  };
}

/** Sticky date headings and the scroll padding are outside the usable row viewport. */
export function sidebarRowNeedsReveal(row: { top: number; bottom: number }, viewport: { top: number; bottom: number }, paddingTop: number, paddingBottom: number, stickyBottom = viewport.top): boolean {
  const top = Math.max(viewport.top + paddingTop, stickyBottom);
  const bottom = viewport.bottom - paddingBottom;
  return row.top < top - 1 || row.bottom > bottom + 1;
}
