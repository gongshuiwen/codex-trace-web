import { useMemo, useState } from 'react';
import type { ToolCall } from '../shared/types';
import { readToolOutput, webResultLinks, type ToolPresentation } from './tool-presentation';

function JsonValue({ value, name, depth = 0 }: { value: unknown; name?: string; depth?: number }) {
  const complex = value !== null && typeof value === 'object';
  const entries = complex ? Object.entries(value) : [];
  const [expanded, setExpanded] = useState(depth < 1);
  const [limit, setLimit] = useState(40);
  const prefix = name != null ? <span className="tool-json-key">{name}: </span> : null;
  if (!complex) return <div className="tool-json-scalar">{prefix}<span>{JSON.stringify(value)}</span></div>;
  return <div className="tool-json-node">
    <button type="button" className="tool-json-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span>{prefix}<span>{Array.isArray(value) ? `数组 · ${entries.length} 项` : `对象 · ${entries.length} 个字段`}</span></button>
    {expanded && <div className="tool-json-children">{entries.slice(0, limit).map(([key, child]) => <JsonValue key={key} name={key} value={child} depth={depth + 1} />)}{entries.length > limit && <button type="button" className="tool-result-text-button" onClick={() => setLimit(value => value + 40)}>继续显示字段 · 剩余 {entries.length - limit} 项</button>}</div>}
  </div>;
}

function PatchResult({ presentation, status }: { presentation: ToolPresentation; status: ToolCall['status'] }) {
  const labels = { add: '新增', update: '修改', delete: '删除', move: '移动' };
  return <div className="tool-patch-result">
    <p className="tool-result-note">{status === 'completed' ? '本次补丁内容' : '请求的补丁内容'} · {presentation.patchFiles.length} 个文件</p>
    {presentation.patchFiles.map((file, index) => <details className="tool-patch-file" key={`${file.path}-${index}`} open={presentation.patchFiles.length === 1 || undefined}>
      <summary><span className="tool-patch-kind">{labels[file.kind]}</span><span>{file.path}{file.movedTo ? ` → ${file.movedTo}` : ''}</span></summary>
      {file.lines.length > 0 && <pre className="tool-call-code tool-patch-code"><code>{file.lines.map((line, lineIndex) => <span className={line.startsWith('+') ? 'tool-diff-add' : line.startsWith('-') ? 'tool-diff-remove' : line.startsWith('@@') ? 'tool-diff-meta' : ''} key={lineIndex}>{line || ' '}</span>)}</code></pre>}
    </details>)}
  </div>;
}

export function ToolResult({ tool, presentation, output, complete }: { tool: ToolCall; presentation: ToolPresentation; output: string; complete: boolean }) {
  const decoded = useMemo(() => readToolOutput(output, complete), [output, complete]);
  const text = presentation.category === 'command' && decoded.envelope ? decoded.text : output;
  const json = decoded.json;
  const hasJson = json !== undefined && !(presentation.category === 'command' && decoded.envelope);
  const links = useMemo(() => presentation.category === 'web' ? webResultLinks(json) : [], [presentation.category, json]);
  return <div className={`tool-result tool-result-${presentation.category}`}>
    {tool.status === 'failed' && <div className="tool-result-diagnostic"><span>{presentation.diagnostic ? '检测到的诊断' : '调用失败'}</span><p>{presentation.diagnostic || (tool.exitCode != null ? `工具返回退出码 ${tool.exitCode}，可查看原始返回。` : '日志记录了失败标记，可查看原始返回。')}</p></div>}
    <dl className="tool-result-metadata">
      <div><dt>工具</dt><dd><code>{tool.name}</code></dd></div>
      {presentation.cwd && <div><dt>工作目录</dt><dd>{presentation.cwd}</dd></div>}
      {presentation.shell && <div><dt>Shell</dt><dd>{presentation.shell}</dd></div>}
      {tool.exitCode != null && <div><dt>退出码</dt><dd>{tool.exitCode}</dd></div>}
      {presentation.target && !presentation.command && <div><dt>目标</dt><dd>{presentation.target}</dd></div>}
    </dl>
    {presentation.command && <pre className="tool-call-code tool-command"><code>{presentation.command}</code></pre>}
    {presentation.queries.length > 0 && <div className="tool-result-queries"><span className="tool-result-note">查询内容</span>{presentation.queries.map((query, index) => <p key={index}>{query}</p>)}</div>}
    {presentation.category === 'patch' && presentation.patchFiles.length > 0 && <PatchResult presentation={presentation} status={tool.status} />}
    {!complete && <p className="tool-result-note tool-output-partial">当前为部分返回，完整读取后才展示结构化内容。</p>}
    {links.length > 0 ? <ol className="tool-web-results">{links.map((link, index) => <li key={index}><a href={link.url} target="_blank" rel="noopener noreferrer">{link.title}</a><span>{link.url}</span>{link.snippet && <p>{link.snippet}</p>}</li>)}</ol> : hasJson ? <div className="tool-json-view" aria-label="结构化返回"><JsonValue key={tool.id} value={json} /></div> : text ? <pre className="tool-call-code tool-result-output"><code>{text}</code></pre> : <p className="tool-result-empty">{tool.status === 'running' ? '等待工具返回…' : tool.status === 'unknown' ? '日志包含调用记录，未记录对应返回。' : '返回内容为空'}</p>}
  </div>;
}
