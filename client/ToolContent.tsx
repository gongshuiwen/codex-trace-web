import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Check, Copy } from 'lucide-react';
import type { ToolCall, ToolSearchLocation } from '../shared/types';
import { prettyArguments } from './format';
import { toolPresentation } from './tool-presentation';
import { ToolResult } from './ToolResult';
import { toolViewState, type ToolViewState } from './tool-view-state';
import { useToolOutput } from './useToolOutput';
import { outputWindowEnd, windowContainsSearch } from './tool-output-window';
import './tool-card.css';
import './tool-content.css';

type Tab = ToolViewState['tab'];
const tabs = [{ id: 'result', label: '关键结果' }, { id: 'arguments', label: '调用参数' }, { id: 'raw', label: '原始返回' }] as const;
const completedNavigations = new Map<string, true>();

function completeNavigation(key: string) {
  completedNavigations.delete(key); completedNavigations.set(key, true);
  while (completedNavigations.size > 500) completedNavigations.delete(completedNavigations.keys().next().value!);
}

function matchesSearchText(actual: string, search: ToolSearchLocation): boolean {
  return search.matchedText !== undefined ? actual === search.matchedText : actual.toLowerCase() === search.query.toLowerCase();
}

/** Keep offsets in the original string; React escapes both text and the marked match. */
export function ToolSearchText({ text, offset = 0, search }: { text: string; offset?: number; search?: ToolSearchLocation }) {
  const start = search ? search.offset - offset : -1;
  const end = start + (search?.length ?? 0);
  const valid = search && start >= 0 && end <= text.length && end > start && matchesSearchText(text.slice(start, end), search);
  if (!valid) return <>{text}</>;
  return <>{text.slice(0, start)}<mark data-tool-search-hit data-tool-search-offset={search.offset} tabIndex={-1}>{text.slice(start, end)}</mark>{text.slice(end)}</>;
}

export function ToolContent({ tool, sessionId, revision, search, navigationId = 0, mode = 'inline', onReady, preserveLayout }: {
  tool: ToolCall; sessionId: string; revision: string; search?: ToolSearchLocation; navigationId?: number;
  mode?: 'inline' | 'detail'; onReady?: () => void; preserveLayout?: (change: () => void) => void;
}) {
  const toolKey = JSON.stringify([sessionId, tool.id]);
  const navigationKey = search ? JSON.stringify([toolKey, mode, navigationId, search.field, search.offset, search.length, search.query, search.matchedText]) : '';
  const [needsNavigation, setNeedsNavigation] = useState(() => Boolean(search && !completedNavigations.has(navigationKey)));
  const [tab, setTab] = useState<Tab>(() => needsNavigation && search ? search.field === 'arguments' ? 'arguments' : 'raw' : toolViewState.get(sessionId, tool.id)?.tab ?? 'result');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyRef = useRef(onReady); readyRef.current = onReady;
  const restored = useRef('');
  const prepend = useRef<{ offset: number; height: number; top: number; markTop?: number } | null>(null);
  const output = useToolOutput({ tool, sessionId, revision, search: needsNavigation ? search : undefined });
  const presentation = useMemo(() => toolPresentation(tool), [tool.name, tool.category, tool.arguments, tool.output, tool.outputTruncated, tool.status, tool.exitCode]);
  const rawArguments = Boolean(search?.field === 'arguments');
  const text = tab === 'arguments' ? rawArguments ? tool.arguments : prettyArguments(tool.arguments) : output.window.text;
  const textOffset = tab === 'arguments' ? 0 : output.window.offset;
  const currentSearch = search && (tab === 'arguments' && search.field === 'arguments' || tab === 'raw' && search.field === 'output') ? search : undefined;
  const hitInWindow = search?.field === 'arguments' ? search.offset >= 0 && search.offset + search.length <= tool.arguments.length : search ? windowContainsSearch(output.window, search) : false;
  const actualHit = search?.field === 'arguments' ? tool.arguments.slice(search.offset, search.offset + search.length) : search && hitInWindow ? output.window.text.slice(search.offset - output.window.offset, search.offset - output.window.offset + search.length) : '';
  const hitValid = Boolean(search && search.length > 0 && hitInWindow && matchesSearchText(actualHit, search));

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  function selectTab(next: Tab, manual = true) {
    const change = () => {
      const previous = toolViewState.get(sessionId, tool.id);
      toolViewState.set(sessionId, tool.id, { open: previous?.open ?? tool.status === 'failed', tab: next });
      setTab(next); setCopied(false); setCopyError('');
    };
    if (manual && preserveLayout) preserveLayout(change); else change();
  }
  useEffect(() => { if (needsNavigation && search) selectTab(search.field === 'arguments' ? 'arguments' : 'raw', false); }, [navigationKey]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (prepend.current && output.window.offset < prepend.current.offset) {
      const mark = panel.querySelector<HTMLElement>('[data-tool-search-hit]');
      if (mark && prepend.current.markTop !== undefined) panel.scrollTop += mark.getBoundingClientRect().top - panel.getBoundingClientRect().top - prepend.current.markTop;
      else panel.scrollTop = prepend.current.top + panel.scrollHeight - prepend.current.height;
      output.saveScroll(tab, panel.scrollTop);
      prepend.current = null;
    }
    if (needsNavigation && search) {
      if (output.loading || output.locating) return;
      const mark = panel.querySelector<HTMLElement>('[data-tool-search-hit]');
      if (mark) {
        panel.scrollTop += mark.getBoundingClientRect().top - panel.getBoundingClientRect().top - Math.min(panel.clientHeight / 3, 120);
        mark.focus({ preventScroll: true });
      } else if (!output.error && !hitInWindow) {
        // A response can shrink between search and retrieval; report the stale position visibly.
      }
      completeNavigation(navigationKey); setNeedsNavigation(false);
      readyRef.current?.();
      output.saveScroll(tab, panel.scrollTop);
      restored.current = `${output.source}\u0000${tab}`;
      return;
    }
    const restoreKey = `${output.source}\u0000${tab}`;
    if (restored.current !== restoreKey && !output.loading && !output.restoring) {
      panel.scrollTop = output.getScroll(tab);
      restored.current = restoreKey;
    }
  }, [navigationKey, needsNavigation, tab, output.source, output.window.offset, output.window.text, output.loading, output.locating, output.restoring, output.error]);

  async function copy() {
    setCopyError('');
    try {
      await navigator.clipboard.writeText(tab === 'arguments' ? tool.arguments : output.window.text);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch { setCopyError('复制失败，请手动选择文本'); }
  }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
    if (next == null) return;
    event.preventDefault(); selectTab(tabs[next].id);
    document.getElementById(`${panelId}-tab-${tabs[next].id}`)?.focus();
  }
  const noReturn = !output.window.text && (tool.status === 'running' || tool.status === 'unknown');
  const start = output.window.text.length ? output.window.offset + 1 : 0;
  const end = outputWindowEnd(output.window);
  return <div className={`tool-content tool-content-${mode}`}>
    <div className="tool-call-toolbar">
      <div className="tool-call-tabs" role="tablist" aria-label="工具调用内容">{tabs.map((item, index) => <button type="button" role="tab" id={`${panelId}-tab-${item.id}`} key={item.id} aria-selected={tab === item.id} aria-controls={`${panelId}-panel`} tabIndex={tab === item.id ? 0 : -1} onKeyDown={event => moveTab(event, index)} onClick={() => selectTab(item.id)}>{item.label}</button>)}</div>
      <button type="button" className="tool-call-copy" onClick={() => void copy()} title={tab === 'arguments' ? '复制原始调用参数' : output.complete ? '复制完整原始返回' : `复制当前原始返回范围 ${start}–${end} 字符`}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : tab === 'arguments' ? '复制参数' : output.complete ? '复制返回' : '复制当前范围'}</button>
    </div>
    {search && <div className="tool-search-location" role="status">{output.loading || output.locating ? '正在读取命中位置…' : hitValid ? `命中${search.field === 'arguments' ? '调用参数' : '原始返回'} · 第 ${(search.offset + 1).toLocaleString()} 字符` : '命中位置已变化，请重新搜索。'}</div>}
    {!search && output.restoring && <div className="tool-search-location" role="status">正在恢复上次读取位置…</div>}
    <div className="tool-call-panel" ref={panelRef} role="tabpanel" id={`${panelId}-panel`} aria-labelledby={`${panelId}-tab-${tab}`} aria-busy={output.loading || undefined} tabIndex={0} onScroll={event => { if (!output.restoring && !output.locating) output.saveScroll(tab, event.currentTarget.scrollTop); }}>
      {tab === 'result' ? <ToolResult tool={tool} presentation={presentation} output={output.window.text} complete={output.complete} /> : <pre className="tool-call-code"><code>{text ? <ToolSearchText text={text} offset={textOffset} search={currentSearch} /> : tab === 'arguments' ? '没有记录调用参数' : tool.status === 'running' ? '等待返回…' : tool.status === 'unknown' ? '日志未记录对应返回' : '返回内容为空'}</code></pre>}
    </div>
    {tab !== 'arguments' && <div className="tool-call-output-footer">
      <span>{noReturn ? tool.status === 'running' ? '等待返回' : '返回未记录' : output.complete ? `返回 ${output.window.totalLength.toLocaleString()} 字符` : `当前范围 ${start.toLocaleString()}–${end.toLocaleString()} / ${output.window.totalLength.toLocaleString()} 字符`}</span>
      <div className="tool-output-page-actions">
        {output.canLoadBefore && <button type="button" disabled={output.loading} onClick={() => { const panel = panelRef.current; const mark = panel?.querySelector<HTMLElement>('[data-tool-search-hit]'); if (panel) prepend.current = { offset: output.window.offset, height: panel.scrollHeight, top: panel.scrollTop, ...(mark ? { markTop: mark.getBoundingClientRect().top - panel.getBoundingClientRect().top } : {}) }; void output.loadBefore(); }}><ArrowUp size={13} />读取前文</button>}
        {output.canLoadAfter && <button type="button" disabled={output.loading} onClick={() => void output.loadAfter()}><ArrowDown size={13} />{output.loading ? '加载中…' : '继续读取输出'}</button>}
        {output.error && <button type="button" disabled={output.loading} onClick={() => { if (search?.field === 'output' && !hitValid) setNeedsNavigation(true); else void output.retry(); }}>重试读取输出</button>}
      </div>
    </div>}
    {(output.error || copyError) && <p className="tool-call-error" role="alert">{copyError || output.error}</p>}
    {copied && <span className="sr-only" role="status">{tab === 'arguments' ? '原始调用参数已复制' : output.complete ? '完整原始返回已复制' : '当前范围的原始返回已复制'}</span>}
  </div>;
}
