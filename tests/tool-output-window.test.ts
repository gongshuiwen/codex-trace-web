import { describe, expect, it } from 'vitest';
import type { OutputPage, ToolCall } from '../shared/types';
import { completeOutputWindow, initialToolOutput, mergeOutputWindow, outputSearchPage, outputWindowEnd, pageOutputWindow, toolOutputSource, windowContainsSearch } from '../client/tool-output-window';

function page(offset: number, text: string, totalLength = 10): OutputPage {
  return { offset, text, totalLength, nextOffset: offset + text.length < totalLength ? offset + text.length : null };
}

describe('tool output windows', () => {
  it('joins contiguous output in both directions and recognizes complete coverage', () => {
    const middle = pageOutputWindow(page(3, 'def'));
    const before = mergeOutputWindow(middle, page(0, 'abc'), 'before');
    const all = mergeOutputWindow(before, page(6, 'ghij'), 'after');
    expect(all).toEqual({ offset: 0, text: 'abcdefghij', totalLength: 10 });
    expect(completeOutputWindow(all)).toBe(true);
    expect(completeOutputWindow(middle)).toBe(false);
    expect(completeOutputWindow({ offset: 3, text: 'defghij', totalLength: 10 })).toBe(false);
  });

  it('deduplicates overlapping pages, including a page wholly inside the window', () => {
    const start = pageOutputWindow(page(0, 'abcdef'));
    expect(mergeOutputWindow(start, page(3, 'defghi'), 'after').text).toBe('abcdefghi');
    expect(mergeOutputWindow(start, page(2, 'cd'), 'after').text).toBe('abcdef');
    expect(mergeOutputWindow(pageOutputWindow(page(3, 'def')), page(0, 'abcdefghij'), 'before').text).toBe('abcdefghij');
  });

  it('refuses gaps, changed lengths, and rewritten overlap rather than combining unrelated text', () => {
    const start = pageOutputWindow(page(0, 'abc'));
    expect(() => mergeOutputWindow(start, page(4, 'ef'), 'after')).toThrow('不连续');
    expect(() => mergeOutputWindow(start, page(3, 'def', 11), 'after')).toThrow('已变化');
    expect(() => mergeOutputWindow(start, page(2, 'Xde'), 'after')).toThrow('已变化');
  });

  it('bounds retained text while preserving the absolute range in the chosen direction', () => {
    const start = pageOutputWindow(page(0, 'abcdef'));
    expect(mergeOutputWindow(start, page(6, 'ghij'), 'after', 7)).toEqual({ offset: 3, text: 'defghij', totalLength: 10 });
    expect(mergeOutputWindow(pageOutputWindow(page(4, 'efghij')), page(0, 'abcd'), 'before', 7)).toEqual({ offset: 0, text: 'abcdefg', totalLength: 10 });
  });

  it('rejects invalid server ranges', () => {
    expect(() => pageOutputWindow(page(-1, 'a'))).toThrow('范围无效');
    expect(() => pageOutputWindow(page(9, 'abcd'))).toThrow('范围无效');
    expect(() => pageOutputWindow(page(1.5, 'a'))).toThrow('范围无效');
  });

  it('requests a page around a deep hit directly rather than reading from zero', () => {
    const request = outputSearchPage({ offset: 70_000, length: 20 }, 90_000);
    expect(request).toEqual({ offset: 65_904, limit: 16_384 });
    const loaded = { offset: request.offset, text: 'x'.repeat(request.limit), totalLength: 90_000 };
    expect(windowContainsSearch(loaded, { offset: 70_000, length: 20 })).toBe(true);
    expect(windowContainsSearch(loaded, { offset: 80_000, length: 5000 })).toBe(false);
    expect(outputWindowEnd(loaded)).toBe(82_288);
  });

  it('handles a hit near the beginning and constrains large requests to the server page limit', () => {
    expect(outputSearchPage({ offset: 2, length: 4 }, 20)).toEqual({ offset: 0, limit: 16_384 });
    expect(outputSearchPage({ offset: 10, length: 100_000 }, 200_000).limit).toBe(65_536);
  });

  it('keeps revisions, sessions and same-length changed prefixes in separate output sources', () => {
    const tool = { id: 'call', output: 'abc', outputLength: 30, outputTruncated: true } as ToolCall;
    expect(initialToolOutput(tool)).toEqual({ offset: 0, text: 'abc', totalLength: 30 });
    const source = toolOutputSource('session', '1', tool);
    expect(toolOutputSource('session', '2', tool)).not.toBe(source);
    expect(toolOutputSource('other', '1', tool)).not.toBe(source);
    expect(toolOutputSource('session', '1', { ...tool, output: 'abd' })).not.toBe(source);
  });
});
