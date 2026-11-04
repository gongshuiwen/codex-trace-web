import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolSearchText } from '../client/ToolContent';

describe('tool search hit rendering', () => {
  it('highlights only the selected occurrence when the same output contains repeated text', () => {
    const html = renderToStaticMarkup(createElement(ToolSearchText, {
      text: 'needle needle needle',
      search: { field: 'output', offset: 7, length: 6, query: 'needle', matchedText: 'needle' },
    }));
    expect(html).toMatch(/^needle <mark[^>]*data-tool-search-offset="7"[^>]*>needle<\/mark> needle$/);
    expect(html.match(/<mark\b/g)).toHaveLength(1);
  });

  it('uses original UTF16 offsets in a partial output window', () => {
    const html = renderToStaticMarkup(createElement(ToolSearchText, { text: '😀 prefix NEEDLE suffix', offset: 100, search: { field: 'output', offset: 110, length: 6, query: 'needle' } }));
    expect(html).toContain('data-tool-search-offset="110"');
    expect(html).toContain('>NEEDLE</mark>');
    expect(html).toContain('😀 prefix ');
  });

  it('escapes markup and treats search text literally', () => {
    const html = renderToStaticMarkup(createElement(ToolSearchText, { text: 'before <a.*> after', search: { field: 'arguments', offset: 7, length: 5, query: '<a.*>' } }));
    expect(html).toContain('&lt;a.*&gt;</mark>');
    expect(html).not.toContain('<a.*>');
  });

  it('does not mark a stale or out-of-range offset', () => {
    const stale = renderToStaticMarkup(createElement(ToolSearchText, { text: 'different', search: { field: 'output', offset: 0, length: 4, query: 'same' } }));
    const outside = renderToStaticMarkup(createElement(ToolSearchText, { text: 'short', offset: 20, search: { field: 'output', offset: 1, length: 2, query: 'sh' } }));
    expect(stale).not.toContain('<mark');
    expect(outside).not.toContain('<mark');
  });

  it('uses the original matched glyph for case expansions and contextual case mapping', () => {
    const expanded = renderToStaticMarkup(createElement(ToolSearchText, { text: 'İ', search: { field: 'output', offset: 0, length: 1, query: 'i', matchedText: 'İ' } }));
    const contextual = renderToStaticMarkup(createElement(ToolSearchText, { text: 'ΟΣ', search: { field: 'output', offset: 1, length: 1, query: 'ς', matchedText: 'Σ' } }));
    expect(expanded).toContain('>İ</mark>');
    expect(contextual).toContain('>Σ</mark>');
  });

  it('rejects changed original text even when it has the same case-insensitive spelling', () => {
    const html = renderToStaticMarkup(createElement(ToolSearchText, { text: 'needle', search: { field: 'output', offset: 0, length: 6, query: 'needle', matchedText: 'NEEDLE' } }));
    expect(html).not.toContain('<mark');
  });
});
