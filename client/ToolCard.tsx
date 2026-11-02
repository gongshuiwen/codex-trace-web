import { useState } from 'react';
import { Braces, ChevronDown, ChevronRight, Copy, Globe, GitBranch, Check, Terminal, Wrench, FileDiff, LoaderCircle, ArrowDown, Maximize2 } from 'lucide-react';
import type { OutputPage, ToolCall } from '../shared/types';
import { api, errorMessage, sessionPath } from './api';
import { prettyArguments } from './format';

const icons = { command: Terminal, mcp: Wrench, patch: FileDiff, web: Globe, agent: GitBranch, other: Braces };

export function ToolCard({ tool, sessionId, onInspect }: { tool: ToolCall; sessionId: string; onInspect: () => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'output' | 'arguments'>('output');
  const [page, setPage] = useState<{ text: string; next: number | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const Icon = icons[tool.category];
  const text = tab === 'arguments' ? prettyArguments(tool.arguments) : page?.text ?? tool.output;
  const nextOffset = page ? page.next ?? (page.text.length < tool.outputLength ? page.text.length : null) : tool.outputTruncated ? tool.output.length : null;
  async function loadMore() {
    if (nextOffset == null || loading) return;
    setLoading(true); setError('');
    try {
      const result = await api<OutputPage>(`${sessionPath(sessionId)}/tools/${encodeURIComponent(tool.id)}/output?offset=${nextOffset}&limit=16384`);
      setPage(previous => ({ text: (previous?.text ?? tool.output) + result.text, next: result.nextOffset }));
    } catch (cause) { setError(errorMessage(cause)); } finally { setLoading(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setError('复制失败，请手动选择文本'); }
  }
  return <div className={`tool-card ${open ? 'tool-open' : ''}`}>
    <div className="tool-card-heading"><button className="tool-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Icon size={15} /><span>{tool.name}</span><span className={`tool-status ${tool.status}`}>{tool.status === 'running' ? <><LoaderCircle size={12} className="spin" />运行中</> : tool.status === 'failed' ? `失败${tool.exitCode != null ? ` · ${tool.exitCode}` : ''}` : tool.status === 'completed' ? <><Check size={12} />完成</> : '已记录'}</span></button><button className="icon-button tool-inspect" title="查看调用详情" aria-label={`查看 ${tool.name} 调用详情`} onClick={onInspect}><Maximize2 size={13} /></button></div>
    {open && <div className="tool-body"><div className="tool-tabs"><button className={tab === 'output' ? 'active' : ''} onClick={() => setTab('output')}>返回内容</button><button className={tab === 'arguments' ? 'active' : ''} onClick={() => setTab('arguments')}>调用参数</button><button className="copy-button" title="复制当前内容" onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button></div><pre className="tool-code"><code>{text || (tool.status === 'running' ? '等待返回…' : '没有记录内容')}</code></pre>{tab === 'output' && nextOffset != null && <button className="tool-more" onClick={() => void loadMore()} disabled={loading}><ArrowDown size={13} />{loading ? '加载中…' : `继续读取输出 · 已显示 ${text.length.toLocaleString()} / ${tool.outputLength.toLocaleString()} 字符`}</button>}{error && <p className="inline-error" role="alert">{error}</p>}</div>}
  </div>;
}
