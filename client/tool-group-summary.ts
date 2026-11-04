import type { ToolCall } from '../shared/types';
import { readToolOutput, toolPresentation } from './tool-presentation';

export type ToolGroupCategory = ToolCall['category'] | 'script';

const labels: Record<ToolGroupCategory, string> = {
  command: '命令', patch: '补丁', web: '网页', mcp: 'MCP', agent: '协作', script: '脚本', other: '其他',
};

export interface ToolGroupSummary {
  categories: { category: ToolGroupCategory; label: string; count: number }[];
  categoryText: string;
  singlePreview?: string;
  firstFailure?: { toolId: string; title: string; preview: string };
}

/** Count recorded calls, preserving their first appearance; never infer inner script operations. */
export function summarizeToolGroup(tools: readonly ToolCall[]): ToolGroupSummary {
  const counts = new Map<ToolGroupCategory, number>();
  let firstFailure: ToolGroupSummary['firstFailure'];
  let singlePreview: string | undefined;
  for (const tool of tools) {
    const presentation = toolPresentation(tool);
    const category = presentation.category === 'other' && /^(?:functions[._]{1,2})?exec$/i.test(tool.name) ? 'script' : presentation.category;
    counts.set(category, (counts.get(category) ?? 0) + 1);
    if (tools.length === 1) singlePreview = [presentation.title, presentation.subtitle].filter(Boolean).join(' · ');
    if (!firstFailure && tool.status === 'failed') {
      const recordedExitCode = Number.isFinite(tool.exitCode) ? tool.exitCode : undefined;
      const exitCode = recordedExitCode ?? readToolOutput(tool.output, !tool.outputTruncated).exitCode;
      const candidate = presentation.diagnostic?.trim();
      // A nested result envelope can match a compiler pattern far into its JSON.
      // Keep metadata out of the one-line preview; the full result remains in details.
      const readableDiagnostic = candidate && !candidate.startsWith('{') && !candidate.startsWith('[') ? candidate : undefined;
      const diagnostic = readableDiagnostic ?? (exitCode != null
        ? `退出码 ${exitCode}（日志记录失败）` : '日志记录了失败标记，未提供诊断');
      firstFailure = { toolId: tool.id, title: presentation.title, preview: `${presentation.title} · ${diagnostic}` };
    }
  }
  const categories = [...counts].map(([category, count]) => ({ category, label: labels[category], count }));
  return { categories, categoryText: categories.map(({ label, count }) => `${label} ${count.toLocaleString()}`).join(' · '), singlePreview, firstFailure };
}
