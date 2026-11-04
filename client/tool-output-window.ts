import type { OutputPage, ToolCall, ToolSearchLocation } from '../shared/types';

export const TOOL_OUTPUT_PAGE_SIZE = 16_384;
export const TOOL_OUTPUT_WINDOW_LIMIT = 262_144;
export interface ToolOutputWindow { text: string; offset: number; totalLength: number }

export function initialToolOutput(tool: ToolCall): ToolOutputWindow {
  return { text: tool.output, offset: 0, totalLength: tool.outputLength };
}

export function outputWindowEnd(window: ToolOutputWindow): number { return window.offset + window.text.length; }
export function completeOutputWindow(window: ToolOutputWindow): boolean { return window.offset === 0 && outputWindowEnd(window) >= window.totalLength; }

export function pageOutputWindow(page: OutputPage): ToolOutputWindow {
  if (!Number.isInteger(page.offset) || page.offset < 0 || !Number.isInteger(page.totalLength) || page.totalLength < 0 || page.offset > page.totalLength || page.offset + page.text.length > page.totalLength) {
    throw new Error('工具返回的字符范围无效，请重新读取调用详情。');
  }
  return { text: page.text, offset: page.offset, totalLength: page.totalLength };
}

/** Join adjacent pages without duplicating overlap or mixing rewritten output. */
export function mergeOutputWindow(current: ToolOutputWindow, page: OutputPage, direction: 'before' | 'after', limit = TOOL_OUTPUT_WINDOW_LIMIT): ToolOutputWindow {
  const incoming = pageOutputWindow(page);
  if (current.totalLength !== incoming.totalLength) throw new Error('工具返回已变化，请等待日志更新后重试。');
  const start = Math.min(current.offset, incoming.offset);
  const end = Math.max(outputWindowEnd(current), outputWindowEnd(incoming));
  const overlapStart = Math.max(current.offset, incoming.offset);
  const overlapEnd = Math.min(outputWindowEnd(current), outputWindowEnd(incoming));
  if (overlapStart > overlapEnd) throw new Error('工具返回的分页范围不连续，请重新定位。');
  if (current.text.slice(overlapStart - current.offset, overlapEnd - current.offset) !== incoming.text.slice(overlapStart - incoming.offset, overlapEnd - incoming.offset)) {
    throw new Error('工具返回内容已变化，请等待日志更新后重试。');
  }
  const first = current.offset <= incoming.offset ? current : incoming;
  const last = first === current ? incoming : current;
  let text = first.text + last.text.slice(Math.max(0, outputWindowEnd(first) - last.offset));
  let offset = start;
  if (text.length > limit) {
    if (direction === 'after') { offset = end - limit; text = text.slice(-limit); }
    else text = text.slice(0, limit);
  }
  return { text, offset, totalLength: current.totalLength };
}

export function outputSearchPage(search: Pick<ToolSearchLocation, 'offset' | 'length'>, totalLength: number) {
  const offset = Math.max(0, Math.min(totalLength, Math.trunc(search.offset) - 4096));
  const limit = Math.min(65_536, Math.max(TOOL_OUTPUT_PAGE_SIZE, search.length + 8192));
  return { offset, limit };
}

export function windowContainsSearch(window: ToolOutputWindow, search: Pick<ToolSearchLocation, 'offset' | 'length'>): boolean {
  return search.offset >= window.offset && search.offset + search.length <= outputWindowEnd(window);
}

export function toolOutputSource(sessionId: string, revision: string, tool: ToolCall): string {
  return JSON.stringify([sessionId, revision, tool.id, tool.outputLength, tool.outputTruncated, tool.output]);
}
