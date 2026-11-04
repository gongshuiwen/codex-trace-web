import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X, type LucideIcon } from 'lucide-react';
import { api, errorMessage, isAbort, sessionPath } from './api';
import './tool-failures.css';

const PAGE_SIZE = 20;

interface RecordPage<T> { items: T[]; total: number; nextOffset: number | null }

export interface SessionRecordNavigatorProps<T> {
  active?: boolean;
  sessionId: string;
  revision: string;
  requestId: number;
  turnIds: string[];
  captureNavigationIntent: () => () => boolean;
  onSelect: (item: T) => void;
  onClose: () => void;
}

interface NavigatorConfig<T> {
  kind: 'failure' | 'compaction';
  endpoint: string;
  label: string;
  empty: string;
  icon: LucideIcon;
  getItemId: (item: T) => string;
  describeItem: (item: T) => string;
}

/** Share paging and navigation cancellation without changing a record's expanded content. */
export function SessionRecordNavigator<T extends { turnId: string }>({ active = true, sessionId, revision, requestId, turnIds, captureNavigationIntent, onSelect, onClose, config }: SessionRecordNavigatorProps<T> & { config: NavigatorConfig<T> }) {
  const [page, setPage] = useState<(RecordPage<T> & { offset: number }) | null>(null);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const source = JSON.stringify([sessionId, revision, config.endpoint]);
  const currentSource = useRef(source); currentSource.current = source;
  const previousSource = useRef(source);
  const controllerRef = useRef<AbortController | null>(null);
  const selectRef = useRef(onSelect); selectRef.current = onSelect;
  const activeRef = useRef(active); activeRef.current = active;
  const current = page?.items[index - page.offset];
  const turnIndex = current ? turnIds.indexOf(current.turnId) : -1;

  async function showRecord(next: number, refresh = false) {
    if (!refresh && !stale && page && next >= page.offset && next < page.offset + page.items.length) {
      setIndex(next); selectRef.current(page.items[next - page.offset]); return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    const canNavigate = captureNavigationIntent();
    setLoading(true); setError(''); setStale(false);
    try {
      let offset = Math.max(0, Math.floor(next / PAGE_SIZE) * PAGE_SIZE);
      const readPage = (from: number) => api<RecordPage<T>>(`${sessionPath(sessionId)}${config.endpoint}?offset=${from}&limit=${PAGE_SIZE}`, { signal: controller.signal });
      let result = await readPage(offset);
      if (controller.signal.aborted || currentSource.current !== source) return;
      const selectedIndex = Math.max(0, Math.min(next, result.total - 1));
      if (result.total > 0 && selectedIndex < offset) {
        offset = Math.floor(selectedIndex / PAGE_SIZE) * PAGE_SIZE;
        result = await readPage(offset);
        if (controller.signal.aborted || currentSource.current !== source) return;
      }
      setPage({ ...result, offset }); setIndex(selectedIndex);
      const selected = result.items[selectedIndex - offset];
      if (selected && activeRef.current && canNavigate()) selectRef.current(selected);
    } catch (cause) {
      if (!controller.signal.aborted && currentSource.current === source && !isAbort(cause)) setError(errorMessage(cause));
    } finally { if (controllerRef.current === controller) setLoading(false); }
  }
  // Invalidate an old revision before a simultaneous explicit request starts its new fetch.
  useEffect(() => {
    if (previousSource.current !== source) {
      previousSource.current = source; controllerRef.current?.abort(); setLoading(false); setStale(true);
    }
  }, [source]);
  useEffect(() => { void showRecord(0, true); }, [sessionId, config.endpoint, requestId]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const failure = config.kind === 'failure';
  const legacy = (name: string) => failure ? ` tool-failure-${name}` : '';
  const currentId = current ? config.getItemId(current) : undefined;
  const currentDescription = current ? config.describeItem(current) : '';
  const currentAttribute = failure ? { 'data-current-failure-id': currentId } : { 'data-current-compaction-id': currentId };
  const Icon = config.icon;
  return <div className={`session-record-navigation${legacy('navigation')} ${failure ? '' : 'compaction-navigation'}`} {...currentAttribute}>
    <div className={`session-record-navigation-main${legacy('navigation-main')}`}>
      <Icon size={15} className={`session-record-symbol${legacy('symbol')}`} aria-hidden="true" />
      <span className={`session-record-position${legacy('position')}`} role="status">{loading ? `正在读取${config.label}…` : page?.total === 0 ? config.empty : page ? `${config.label} ${index + 1} / ${page.total}` : config.label}</span>
      {current && <span className={`session-record-current${legacy('current')}`} title={currentDescription}>{turnIndex >= 0 ? `第 ${turnIndex + 1} 轮 · ` : ''}{currentDescription}</span>}
      <div className={`session-record-actions${legacy('actions')}`}>
        {stale || error ? <button type="button" onClick={() => void showRecord(index, true)} disabled={loading}>{stale ? '记录已更新，刷新列表' : '重试读取'}</button> : <>
          <button type="button" onClick={() => void showRecord(index - 1)} disabled={loading || !page || index <= 0} aria-label={`上一个${config.label}`}><ChevronLeft size={15} />上一个</button>
          <button type="button" onClick={() => void showRecord(index + 1)} disabled={loading || !page || index + 1 >= page.total} aria-label={`下一个${config.label}`}>下一个<ChevronRight size={15} /></button>
        </>}
        <button type="button" className="icon-button" onClick={onClose} aria-label={`关闭${config.label}导航`}><X size={15} /></button>
      </div>
    </div>
    {error && <p className={`session-record-error${legacy('error')}`} role="alert">{error}</p>}
  </div>;
}
