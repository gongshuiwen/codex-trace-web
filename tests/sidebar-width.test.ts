import { describe, expect, it } from 'vitest';
import { readSidebarWidth, saveSidebarWidth, sidebarWidth, sidebarWidthLimit, SIDEBAR_WIDTH_KEY } from '../client/sidebar-width';

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('sidebar width preferences', () => {
  it('uses the reading workspace default when no valid preference is available', () => {
    expect(sidebarWidth(null, 1440)).toBe(280);
    expect(sidebarWidth(null, 1200)).toBe(280);
    expect(sidebarWidth(Number.NaN, 1440)).toBe(280);
    expect(sidebarWidth(Number.POSITIVE_INFINITY, 1200)).toBe(280);
  });

  it('bounds manual widths while reserving space for the main panel', () => {
    expect(sidebarWidth(100, 1440)).toBe(260);
    expect(sidebarWidth(900, 1440)).toBe(640);
    expect(sidebarWidth(640, 1000)).toBe(520);
    expect(sidebarWidthLimit(901)).toBe(421);
    expect(sidebarWidthLimit(640)).toBe(260);
  });

  it('round-trips a manual width and removes the preference when reset', () => {
    const cache = storage();
    expect(readSidebarWidth(cache)).toBeNull();
    saveSidebarWidth(468.6, cache);
    expect(readSidebarWidth(cache)).toBe(469);
    saveSidebarWidth(null, cache);
    expect(cache.values.has(SIDEBAR_WIDTH_KEY)).toBe(false);
    expect(readSidebarWidth(cache)).toBeNull();
  });

  it('keeps the saved preference while a narrow window temporarily limits its display', () => {
    const cache = storage();
    saveSidebarWidth(640, cache);
    const preferred = readSidebarWidth(cache);
    expect(sidebarWidth(preferred, 901)).toBe(421);
    expect(readSidebarWidth(cache)).toBe(640);
    expect(sidebarWidth(preferred, 1440)).toBe(640);
  });

  it('ignores malformed, nonfinite and out-of-range saved values', () => {
    const cache = storage();
    for (const raw of ['', ' ', 'not a width', 'null', '{}', '[]', 'true', 'NaN', 'Infinity', '-Infinity', '259', '641', '0']) {
      cache.values.set(SIDEBAR_WIDTH_KEY, raw);
      expect(readSidebarWidth(cache), raw).toBeNull();
    }
  });

  it('bounds finite values on save and does not replace a preference with nonfinite input', () => {
    const cache = storage();
    saveSidebarWidth(100, cache);
    expect(readSidebarWidth(cache)).toBe(260);
    saveSidebarWidth(900, cache);
    expect(readSidebarWidth(cache)).toBe(640);
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      saveSidebarWidth(invalid, cache);
      expect(readSidebarWidth(cache)).toBe(640);
    }
  });

  it('allows reading and resizing to continue when browser storage is denied', () => {
    const denied = {
      getItem() { throw new Error('read denied'); },
      setItem() { throw new Error('write denied'); },
      removeItem() { throw new Error('remove denied'); },
    };
    expect(readSidebarWidth(denied)).toBeNull();
    expect(() => saveSidebarWidth(480, denied)).not.toThrow();
    expect(() => saveSidebarWidth(null, denied)).not.toThrow();
    expect(sidebarWidth(480, 1440)).toBe(480);
  });
});
