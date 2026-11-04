import { describe, expect, it } from 'vitest';
import { parseSessionLocation, sessionLocationUrl } from '../client/session-location';

describe('session view links', () => {
  const original = new URL('http://localhost/?session=s&turn=reading-turn');
  it('keeps the reading target separate from the selected usage call and round', () => {
    const next = { ...parseSessionLocation(original), view: 'usage' as const, request: 'call/a', usageTurn: 'round 2', focus: 'cache' as const };
    const url = sessionLocationUrl(original, next);
    expect(parseSessionLocation(new URL(url.href))).toEqual(next);
    expect(url.searchParams.get('turn')).toBe('reading-turn');
  });
  it('keeps call selection when switching views and restores it from the URL', () => {
    const selected = parseSessionLocation(new URL('http://localhost/?session=s&view=usage&request=call-2'));
    const conversation = sessionLocationUrl(original, { ...selected, view: 'conversation' });
    expect(conversation.searchParams.has('view')).toBe(false);
    const restored = parseSessionLocation(conversation);
    expect(restored.request).toBe('call-2');
    expect(parseSessionLocation(sessionLocationUrl(conversation, { ...restored, view: 'usage' }))).toEqual(selected);
  });
  it('removes stale selection and round filters for a fresh metric shortcut', () => {
    const url = new URL('http://localhost/?session=s&view=usage&request=old&usageTurn=old-round');
    const next = sessionLocationUrl(url, { ...parseSessionLocation(url), request: null, usageTurn: null, focus: 'latest' });
    expect(next.searchParams.has('request')).toBe(false);
    expect(next.searchParams.has('usageTurn')).toBe(false);
    expect(parseSessionLocation(next).focus).toBe('latest');
  });
  it('supports older Token view history entries and rejects unknown views and focus values', () => {
    expect(parseSessionLocation(original, 'tokens').view).toBe('usage');
    expect(parseSessionLocation(new URL('http://localhost/?view=tokens')).view).toBe('usage');
    expect(parseSessionLocation(new URL('http://localhost/?view=other&focus=other'))).toMatchObject({ view: 'conversation', focus: null });
    expect(parseSessionLocation(new URL('http://localhost/?view=collaboration'), 'tokens').view).toBe('collaboration');
  });
});
