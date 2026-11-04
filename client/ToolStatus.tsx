import { Check, CircleHelp, CircleX, LoaderCircle } from 'lucide-react';
import type { ToolCall } from '../shared/types';

export function ToolStatus({ tool }: { tool: ToolCall }) {
  if (tool.status === 'running') return <span className="tool-call-state running"><LoaderCircle size={13} aria-hidden="true" className="spin" />运行中</span>;
  if (tool.status === 'failed') return <span className="tool-call-state failed" title={tool.exitCode != null ? `失败 · 退出码 ${tool.exitCode}` : undefined}><CircleX size={13} aria-hidden="true" />失败</span>;
  if (tool.status === 'unknown') return <span className="tool-call-state unknown"><CircleHelp size={13} aria-hidden="true" />结果未记录</span>;
  return <span className="tool-call-state completed" title={tool.exitCode === 0 ? '完成 · 退出码 0' : undefined}><Check size={13} aria-hidden="true" />{tool.exitCode === 0 ? '完成' : '已返回'}</span>;
}
