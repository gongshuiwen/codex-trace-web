import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { SessionActivity, SessionDetail, SessionSummary } from '../shared/types';
import type { SessionLocation } from './session-location';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { UsageAnalysis } from './UsageAnalysis';
import { CollaborationView } from './CollaborationView';

export default function SessionOverview({ session, location, onNavigate, onSelectSession, onNavigateTurn }: {
  session: SessionDetail;
  location: SessionLocation;
  onNavigate: (next: SessionLocation, replace?: boolean) => void;
  onSelectSession: (session: SessionSummary) => void;
  onNavigateTurn: (turnId: string) => void;
}) {
  const [activity, setActivity] = useState<SessionActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const usageRef = useRef<HTMLDivElement>(null);
  const collaborationRef = useRef<HTMLDivElement>(null);
  const active = location.view !== 'conversation';
  const scrollKey = (view: string) => `session-lens-overview-scroll:${session.session.id}:${view}`;
  useLayoutEffect(() => {
    if (!activity) return;
    for (const [view, ref] of [['usage', usageRef], ['collaboration', collaborationRef]] as const) {
      try { if (ref.current) ref.current.scrollTop = Number(sessionStorage.getItem(scrollKey(view))) || 0; } catch { /* Scroll remains usable without storage. */ }
    }
  }, [Boolean(activity)]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    api<SessionActivity>(`${sessionPath(session.session.id)}/activity`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setActivity(result);
    }).catch(cause => { if (!controller.signal.aborted && !isAbort(cause)) setError(errorMessage(cause)); }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [session.session.id, session.session.revision, retry, active]);
  return <>{(['usage', 'collaboration'] as const).map(view => <div key={view} ref={view === 'usage' ? usageRef : collaborationRef} className="session-overview absolute inset-0 min-h-0 overflow-auto px-[var(--canvas-pad)] py-6 [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] max-[600px]:py-5" aria-label={view === 'usage' ? '用量分析视图' : '子代理协作视图'} aria-hidden={location.view !== view} inert={location.view !== view} style={location.view !== view ? { visibility: 'hidden', pointerEvents: 'none' } : undefined} onScroll={event => {
    if (location.view !== view) return;
    try { sessionStorage.setItem(scrollKey(view), String(event.currentTarget.scrollTop)); } catch { /* Optional scroll persistence. */ }
  }}>
    {loading && location.view === view && <p className="turn-loading" role="status"><LoaderCircle size={14} className="spin" />{activity ? '正在更新…' : '正在读取会话活动…'}</p>}
    {error && <p className="inline-error" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {activity && <>
      {view === 'usage' ? <UsageAnalysis session={session} activity={activity} location={location} onNavigate={onNavigate} onNavigateTurn={onNavigateTurn} active={location.view === 'usage'} /> : <CollaborationView session={session} activity={activity} onSelectSession={onSelectSession} onNavigateTurn={onNavigateTurn} />}
      {activity.warnings.map((warning, index) => <p className="detail-note" key={index}>{warning}</p>)}
    </>}
  </div>)}</>;
}
