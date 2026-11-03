import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { SessionActivity, SessionDetail, SessionSummary } from '../shared/types';
import type { Inspection } from './TurnCard';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { TokenTimeline } from './TokenTimeline';
import { CollaborationView } from './CollaborationView';

export default function SessionOverview({ session, view, onInspect, onSelectSession, onNavigateTurn }: {
  session: SessionDetail;
  view: 'tokens' | 'collaboration';
  onInspect: (selection: Inspection) => void;
  onSelectSession: (session: SessionSummary) => void;
  onNavigateTurn: (turnId: string) => void;
}) {
  const [activity, setActivity] = useState<SessionActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api<SessionActivity>(`${sessionPath(session.session.id)}/activity`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setActivity(result);
    }).catch(cause => { if (!controller.signal.aborted && !isAbort(cause)) setError(errorMessage(cause)); }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [session.session.id, session.session.revision, retry]);
  return <div className="session-overview h-full min-h-0 overflow-auto px-[var(--canvas-pad)] py-6 [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] max-[600px]:py-5" aria-label={view === 'tokens' ? 'Token 与压缩时间轴' : '子代理协作视图'}>
    {loading && <p className="turn-loading" role="status"><LoaderCircle size={14} className="spin" />{activity ? '正在更新…' : '正在读取会话活动…'}</p>}
    {error && <p className="inline-error" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {activity && <>
      {view === 'tokens' ? <TokenTimeline activity={activity} onInspect={onInspect} onNavigateTurn={onNavigateTurn} /> : <CollaborationView session={session} activity={activity} onSelectSession={onSelectSession} onNavigateTurn={onNavigateTurn} />}
      {activity.warnings.map((warning, index) => <p className="detail-note" key={index}>{warning}</p>)}
    </>}
  </div>;
}
