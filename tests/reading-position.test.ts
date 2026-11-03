import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseReadingPosition, indexOffset, locateReadingPosition, readReadingPosition, saveReadingPosition, visibleReadingPosition } from '../client/reading-position';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

function scrollingSurface() {
  let mounted = true;
  const scroller = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 }),
    scrollBy(options: ScrollToOptions) { this.scrollTop += options.top || 0; },
    querySelectorAll: () => mounted ? articles : [],
  };
  let targetTop = 1000;
  const target = {
    dataset: { turnId: 'target', turnReady: 'false' },
    getBoundingClientRect: () => ({ top: targetTop - scroller.scrollTop, bottom: targetTop + 2000 - scroller.scrollTop, height: 2000 }),
  };
  const articles = [target];
  const scrollToTurn = vi.fn((offset: number) => { if (mounted && target.dataset.turnReady === 'true') scroller.scrollTop = targetTop + offset; });
  return { scroller: scroller as unknown as HTMLElement, surface: scroller, target, scrollToTurn, moveTarget: (top: number) => { targetTop = top; }, mount: (value: boolean) => { mounted = value; } };
}

describe('reading progress storage', () => {
  it('estimates row offsets from public measured ranges, including unknown gaps', () => {
    expect(indexOffset([{ startIndex: 0, endIndex: 2, size: 100 }, { startIndex: 3, endIndex: 5, size: 200 }], 4)).toBe(500);
    expect(indexOffset([{ startIndex: 2, endIndex: 3, size: 120 }, { startIndex: 6, endIndex: 8, size: 200 }], 7)).toBe(920);
    expect(indexOffset([], 3)).toBeNull();
    expect(indexOffset([{ startIndex: 0, endIndex: 100, size: 700 }], 0)).toBe(0);
  });
  it('stores independent session positions and bounds the history to forty sessions', () => {
    const cache = storage();
    for (let i = 0; i < 45; i++) saveReadingPosition(`s${i}`, { turnId: `t${i}`, offset: i * 10 }, cache);
    expect(readReadingPosition('s0', cache)).toBeNull();
    expect(readReadingPosition('s44', cache)).toEqual({ turnId: 't44', offset: 440 });
    saveReadingPosition('s44', { turnId: 'changed', offset: 12 }, cache);
    expect(readReadingPosition('s44', cache)).toEqual({ turnId: 'changed', offset: 12 });
  });

  it('gives an explicit deep link priority over saved progress, and ignores removed turns', () => {
    const saved = { turnId: 'saved', offset: 200 };
    expect(chooseReadingPosition(['deep', 'saved'], 'deep', saved)).toEqual({ turnId: 'deep', offset: 0 });
    expect(chooseReadingPosition(['deep', 'saved'], null, saved)).toEqual(saved);
    expect(chooseReadingPosition(['deep'], null, saved)).toBeNull();
    expect(chooseReadingPosition(['saved'], 'removed', saved)).toBeNull();
  });

  it('recovers from corrupt storage and tolerates denied browser storage', () => {
    const cache = storage();
    cache.setItem('session-lens-reading-v1', 'not json');
    expect(readReadingPosition('s', cache)).toBeNull();
    saveReadingPosition('s', { turnId: 't', offset: 50 }, cache);
    expect(readReadingPosition('s', cache)).toEqual({ turnId: 't', offset: 50 });
    const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    expect(() => saveReadingPosition('s', { turnId: 't', offset: 1 }, denied)).not.toThrow();
    expect(readReadingPosition('s', denied)).toBeNull();
  });

  it('captures the visible turn and its offset instead of a global pixel position', () => {
    const { scroller, surface } = scrollingSurface();
    surface.scrollTop = 1250;
    expect(visibleReadingPosition(scroller)).toEqual({ turnId: 'target', offset: 250 });
  });
});

describe('bounded turn navigation', () => {
  let browser: EventTarget;
  beforeEach(() => {
    vi.useFakeTimers();
    browser = new EventTarget();
    vi.stubGlobal('window', browser);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 1));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('waits for delayed details, then corrects shifts caused by earlier long turns', () => {
    const { scroller, surface, target, moveTarget, scrollToTurn: coarse } = scrollingSurface();
    const stopped = vi.fn();
    const navigation = locateReadingPosition(scroller, { turnId: 'target', offset: 0 }, coarse, stopped);
    vi.advanceTimersByTime(700);
    expect(coarse).toHaveBeenCalledOnce();
    expect(surface.scrollTop).toBe(0);
    target.dataset.turnReady = 'true';
    navigation.turnReady('target'); vi.advanceTimersByTime(1);
    expect(surface.scrollTop).toBe(1000);
    moveTarget(1600); navigation.layoutChanged(); vi.advanceTimersByTime(1);
    expect(surface.scrollTop).toBe(1600);
    vi.advanceTimersByTime(1800);
    expect(stopped).toHaveBeenCalledOnce();
    moveTarget(2200); navigation.layoutChanged(); vi.advanceTimersByTime(1);
    expect(surface.scrollTop).toBe(1600);
  });

  it('retries when Virtuoso has not mounted the target and sends no layout or ready callback', () => {
    const { scroller, surface, target, mount, scrollToTurn: coarse } = scrollingSurface();
    mount(false);
    locateReadingPosition(scroller, { turnId: 'target', offset: 240 }, coarse, () => {});
    vi.advanceTimersByTime(350);
    expect(coarse.mock.calls.length).toBeGreaterThan(2);
    mount(true); target.dataset.turnReady = 'true';
    vi.advanceTimersByTime(150);
    expect(surface.scrollTop).toBe(1240);
  });

  it('waits for a quiet window after cascading height changes instead of timing out from the first ready state', () => {
    const { scroller, surface, target, moveTarget, mount, scrollToTurn } = scrollingSurface();
    target.dataset.turnReady = 'true';
    const stopped = vi.fn();
    locateReadingPosition(scroller, { turnId: 'target', offset: 0 }, scrollToTurn, stopped);
    vi.advanceTimersByTime(1200);
    moveTarget(1800);
    vi.advanceTimersByTime(150);
    expect(surface.scrollTop).toBe(1800);
    mount(false);
    vi.advanceTimersByTime(1000);
    expect(stopped).not.toHaveBeenCalled();
    mount(true); target.dataset.turnReady = 'false';
    vi.advanceTimersByTime(700);
    expect(stopped).not.toHaveBeenCalled();
    target.dataset.turnReady = 'true'; moveTarget(2400);
    vi.advanceTimersByTime(200);
    expect(surface.scrollTop).toBe(2400);
    expect(stopped).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1800);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('restores a relative reading offset and clamps it when a saved disclosure is now shorter', () => {
    const { scroller, surface, target, scrollToTurn } = scrollingSurface();
    target.dataset.turnReady = 'true';
    const navigation = locateReadingPosition(scroller, { turnId: 'target', offset: 300 }, scrollToTurn, () => {});
    vi.advanceTimersByTime(1);
    expect(surface.scrollTop).toBe(1300);
    navigation.cancel();
    locateReadingPosition(scroller, { turnId: 'target', offset: 10000 }, scrollToTurn, () => {});
    vi.advanceTimersByTime(1);
    expect(surface.scrollTop).toBe(2960);
  });

  it('stops immediately on user interaction, including opening normal content', () => {
    const { scroller, surface, target, scrollToTurn } = scrollingSurface();
    const stopped = vi.fn();
    const navigation = locateReadingPosition(scroller, { turnId: 'target', offset: 0 }, () => {}, stopped);
    browser.dispatchEvent(new Event('pointerdown'));
    target.dataset.turnReady = 'true'; navigation.turnReady('target'); navigation.layoutChanged(); vi.advanceTimersByTime(10);
    expect(stopped).toHaveBeenCalledOnce();
    expect(surface.scrollTop).toBe(0);
  });

  it('can repeat the same target after a previous navigation has finished', () => {
    const { scroller, surface, target, scrollToTurn } = scrollingSurface();
    target.dataset.turnReady = 'true';
    const first = locateReadingPosition(scroller, { turnId: 'target', offset: 0 }, scrollToTurn, () => {});
    vi.advanceTimersByTime(1); first.cancel();
    surface.scrollTop = 100;
    locateReadingPosition(scroller, { turnId: 'target', offset: 0 }, scrollToTurn, () => {});
    vi.advanceTimersByTime(1);
    expect(surface.scrollTop).toBe(1000);
  });

  it('cleans up a target whose details never arrive after a bounded wait', () => {
    const { scroller, surface, target } = scrollingSurface();
    const stopped = vi.fn();
    const navigation = locateReadingPosition(scroller, { turnId: 'target', offset: 0 }, () => {}, stopped);
    vi.advanceTimersByTime(10000);
    target.dataset.turnReady = 'true'; navigation.turnReady('target'); vi.advanceTimersByTime(1);
    expect(stopped).toHaveBeenCalledOnce();
    expect(surface.scrollTop).toBe(0);
  });
});
