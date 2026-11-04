import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { eventViewState } from '../client/event-view-state';
import { UserPrompt } from '../client/UserPrompt';

describe('complete request text and saved disclosure choices', () => {
  it('keeps the full source text in collapsed markup without a character cutoff', () => {
    const text = `${'请求内容'.repeat(400)}\nFULL_TEXT_END`;
    const html = renderToStaticMarkup(createElement(UserPrompt, { text, sessionId: 'prompt-whole-source', stateKey: 'prompt:turn' }));
    expect(html).toContain(text);
    expect(html).toContain('data-expanded="false"');
    expect(html).not.toContain('展开完整请求');
  });

  it('restores the existing main-request preference without sharing it with another session or supplemental message', () => {
    eventViewState.set('prompt-saved', 'prompt:turn', true);
    const render = (sessionId: string, stateKey: string) => renderToStaticMarkup(createElement(UserPrompt, { text: 'saved request', sessionId, stateKey }));
    expect(render('prompt-saved', 'prompt:turn')).toContain('data-expanded="true"');
    expect(render('prompt-other', 'prompt:turn')).toContain('data-expanded="false"');
    expect(render('prompt-saved', 'prompt:turn:supplemental')).toContain('data-expanded="false"');
  });

  it('assigns separate text identities to primary and supplemental requests', () => {
    const html = renderToStaticMarkup(createElement('div', {},
      createElement(UserPrompt, { text: 'main request', sessionId: 'prompt-identities', stateKey: 'prompt:turn' }),
      createElement(UserPrompt, { text: '<supplemental>', sessionId: 'prompt-identities', stateKey: 'prompt:turn:supplemental' }),
    ));
    const ids = [...html.matchAll(/<p id="([^"]+)"/g)].map(match => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(html).toContain('&lt;supplemental&gt;');
  });

  it('keeps the same outer reading anchor when a primary request expands or collapses', () => {
    const props = { text: 'request\n'.repeat(20), sessionId: 'prompt-anchor', stateKey: 'prompt:turn', anchorId: 'user-prompt:turn' };
    const collapsed = renderToStaticMarkup(createElement(UserPrompt, props));
    eventViewState.set(props.sessionId, props.stateKey, true);
    const expanded = renderToStaticMarkup(createElement(UserPrompt, props));
    expect(collapsed).toContain('data-expanded="false" data-event-id="user-prompt:turn"');
    expect(expanded).toContain('data-expanded="true" data-event-id="user-prompt:turn"');
    expect(collapsed.match(/data-event-id=/g)).toHaveLength(1);
    expect(expanded.match(/data-event-id=/g)).toHaveLength(1);
    expect(renderToStaticMarkup(createElement(UserPrompt, { text: 'supplemental request', sessionId: props.sessionId, stateKey: 'prompt:turn:supplemental' }))).not.toContain('data-event-id=');
  });
});
