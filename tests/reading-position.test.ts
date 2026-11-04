import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseReadingPosition, indexOffset, isReadingAtBottom, locateReadingPosition, READING_BOTTOM_TOLERANCE, readReadingPosition, restoreReadingPosition, saveReadingPosition, visibleReadingPosition } from '../client/reading-position';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

function scrollingSurface() {
  let mounted = true;
  interface FakeAnchor {
    dataset: Record<string, string>;
    top: number;
    height: number;
    parent?: FakeAnchor;
    getBoundingClientRect: () => { top: number; bottom: number; height: number };
    closest: (selector: string) => FakeAnchor | undefined;
  }
  const anchors: FakeAnchor[] = [];
  const scroller = {
    scrollTop: 0,
    scrollHeight: 3000,
    clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 }),
    scrollBy(options: ScrollToOptions) { this.scrollTop += options.top || 0; },
    querySelectorAll: () => mounted ? articles : [],
  };
  let targetTop = 1000;
  const target = {
    dataset: { turnId: 'target', turnReady: 'false' },
    getBoundingClientRect: () => ({ top: targetTop - scroller.scrollTop, bottom: targetTop + 2000 - scroller.scrollTop, height: 2000 }),
    querySelectorAll: () => anchors,
  };
  const articles = [target];
  const scrollToTurn = vi.fn((offset: number) => { if (mounted && target.dataset.turnReady === 'true') scroller.scrollTop = targetTop + offset; });
  function addAnchor(dataset: Record<string, string>, top: number, height: number, parent?: FakeAnchor) {
    const element: FakeAnchor = {
      dataset, top, height, parent,
      getBoundingClientRect: () => ({ top: targetTop + element.top - scroller.scrollTop, bottom: targetTop + element.top + element.height - scroller.scrollTop, height: element.height }),
      closest(selector) {
        const key = ({ '[data-event-id]': 'eventId', '[data-tool-group-id]': 'toolGroupId', '[data-process-id]': 'processId' } as Record<string, string>)[selector];
        if (!key) return undefined;
        let node: FakeAnchor | undefined = element;
        while (node) { if (node.dataset[key]) return node; node = node.parent; }
        return undefined;
      },
    };
    anchors.push(element);
    return element;
  }
  return { scroller: scroller as unknown as HTMLElement, surface: scroller, target, scrollToTurn, addAnchor, moveTarget: (top: number) => { targetTop = top; }, mount: (value: boolean) => { mounted = value; } };
}

describe('reading progress storage', () => {
  it('follows only the real bottom within four pixels instead of the old hundred-pixel threshold', () => {
    expect(READING_BOTTOM_TOLERANCE).toBe(4);
    expect(isReadingAtBottom({scrollHeight:3000,scrollTop:2500,clientHeight:500})).toBe(true);
    expect(isReadingAtBottom({scrollHeight:3000,scrollTop:2496,clientHeight:500})).toBe(true);
    expect(isReadingAtBottom({scrollHeight:3000,scrollTop:2495,clientHeight:500})).toBe(false);
    expect(isReadingAtBottom({scrollHeight:3000,scrollTop:2438,clientHeight:500})).toBe(false);
    expect(isReadingAtBottom({scrollHeight:NaN,scrollTop:0,clientHeight:500})).toBe(false);
  });

  it('keeps the visible tool anchor when the reader is sixty-two pixels above the bottom during refresh', () => {
    const {scroller,surface,target,addAnchor,moveTarget}=scrollingSurface();
    target.dataset.turnReady='true';
    addAnchor({toolId:'long-output'},1400,600);
    surface.scrollTop=2438;
    expect(isReadingAtBottom(scroller)).toBe(false);
    const position=visibleReadingPosition(scroller)!;
    expect(position.toolId).toBe('long-output');
    expect(position.anchorOffset).toBe(38);
    moveTarget(1200); surface.scrollHeight=3200;
    restoreReadingPosition(scroller,position);
    expect(surface.scrollTop).toBe(2638);
    expect(surface.scrollHeight-surface.scrollTop-surface.clientHeight).toBe(62);
    expect(isReadingAtBottom(scroller)).toBe(false);
  });

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

  it('round-trips stable anchors and negative viewport offsets while accepting legacy storage', () => {
    const cache = storage();
    cache.setItem('session-lens-reading-v1', JSON.stringify([{sessionId:'old',turnId:'legacy',offset:42}]));
    expect(readReadingPosition('old', cache)).toEqual({turnId:'legacy',offset:42});
    const position = {turnId:'target',offset:230,eventId:'event',toolId:'tool',groupId:'group',anchorOffset:-24,groupAnchorOffset:-12};
    saveReadingPosition('new',position,cache);
    expect(readReadingPosition('new',cache)).toEqual(position);
    saveReadingPosition('new',{...position,anchorOffset:Infinity},cache);
    expect(readReadingPosition('new',cache)).toEqual({turnId:'target',offset:230,eventId:'event',toolId:'tool',groupId:'group',groupAnchorOffset:-12});
    saveReadingPosition('new',{...position,groupAnchorOffset:NaN},cache);
    expect(readReadingPosition('new',cache)).toEqual({turnId:'target',offset:230,eventId:'event',toolId:'tool',groupId:'group',anchorOffset:-24});
    expect(readReadingPosition('old',cache)).toEqual({turnId:'legacy',offset:42});
  });

  it('gives explicit tool navigation priority over a sticky turn URL and saved progress', () => {
    expect(chooseReadingPosition(['target','saved'],'saved',{turnId:'saved',offset:200},
      {turnId:'target',toolId:'call',eventId:'event'})).toEqual({turnId:'target',offset:0,toolId:'call',eventId:'event',anchorOffset:0});
    expect(chooseReadingPosition(['saved'],'saved',null,{turnId:'removed',toolId:'call'})).toBeNull();
  });

  it('round-trips process anchors and ignores invalid process fields in stored positions', () => {
    const cache = storage();
    const position = { turnId: 'target', offset: 400, toolId: 'call', processId: 'process', anchorOffset: -234, processAnchorOffset: -200 };
    saveReadingPosition('process-session', position, cache);
    expect(readReadingPosition('process-session', cache)).toEqual(position);
    cache.setItem('session-lens-reading-v1', JSON.stringify([{ sessionId: 'process-session', turnId: 'target', offset: 400, processId: 42, processAnchorOffset: 'bad' }]));
    expect(readReadingPosition('process-session', cache)).toEqual({ turnId: 'target', offset: 400 });
    saveReadingPosition('process-session', { ...position, processAnchorOffset: Infinity }, cache);
    expect(readReadingPosition('process-session', cache)).toEqual({ turnId: 'target', offset: 400, toolId: 'call', processId: 'process', anchorOffset: -234 });
  });

  it('falls back from a hidden tool to its group, then its collapsed execution process', () => {
    const { scroller, surface, target, addAnchor } = scrollingSurface();
    target.dataset.turnReady = 'true';
    const process = addAnchor({ processId: 'process' }, 200, 1600);
    const group = addAnchor({ toolGroupId: 'group' }, 300, 1000, process);
    const event = addAnchor({ eventId: 'event' }, 400, 400, group);
    const tool = addAnchor({ toolId: 'call' }, 400, 400, event);
    surface.scrollTop = 1450;
    const position = visibleReadingPosition(scroller)!;
    expect(position).toEqual({ turnId: 'target', offset: 450, toolId: 'call', eventId: 'event', groupId: 'group', processId: 'process', anchorOffset: 50, groupAnchorOffset: 150, processAnchorOffset: 250 });
    event.height = 0; tool.height = 0; group.height = 34; process.height = 100;
    restoreReadingPosition(scroller, position);
    expect(surface.scrollTop).toBe(1300);
    group.height = 0; process.height = 44;
    restoreReadingPosition(scroller, position);
    expect(surface.scrollTop).toBe(1200);
    process.height = 0;
    restoreReadingPosition(scroller, position);
    expect(surface.scrollTop).toBe(1450);
  });

  it('preserves a process below the viewport when reading mode hides its next tool', () => {
    const { scroller, surface, target, addAnchor } = scrollingSurface();
    target.dataset.turnReady = 'true';
    const process = addAnchor({ processId: 'process' }, 600, 1600);
    const group = addAnchor({ toolGroupId: 'group' }, 620, 1000, process);
    const tool = addAnchor({ toolId: 'call' }, 654, 40, group);
    surface.scrollTop = 1400;
    const position = visibleReadingPosition(scroller)!;
    expect(position).toMatchObject({ toolId: 'call', groupId: 'group', processId: 'process', anchorOffset: -254, processAnchorOffset: -200 });
    group.height = 0; tool.height = 0; process.height = 44;
    restoreReadingPosition(scroller, position);
    expect(surface.scrollTop).toBe(1400);
    expect(process.getBoundingClientRect().top).toBe(200);
  });

  it('captures and restores an execution process when it has no visible event anchors', () => {
    const { scroller, surface, target, addAnchor } = scrollingSurface();
    target.dataset.turnReady = 'true';
    const process = addAnchor({ processId: 'process' }, 300, 44);
    surface.scrollTop = 1308;
    const position = visibleReadingPosition(scroller)!;
    expect(position).toEqual({ turnId: 'target', offset: 308, processId: 'process', anchorOffset: 8, processAnchorOffset: 8 });
    process.top = 900;
    restoreReadingPosition(scroller, position);
    expect(surface.scrollTop).toBe(1908);
  });

  it('captures the smallest tool anchor at the top and retains its event and group fallback', () => {
    const {scroller,surface,addAnchor} = scrollingSurface();
    const group=addAnchor({toolGroupId:'group'},300,1000);
    const event=addAnchor({eventId:'event'},400,400,group);
    addAnchor({toolId:'call'},400,400,event);
    surface.scrollTop=1450;
    expect(visibleReadingPosition(scroller)).toEqual({turnId:'target',offset:450,toolId:'call',eventId:'event',groupId:'group',anchorOffset:50,groupAnchorOffset:150});
  });

  it('keeps a nearby anchor below the viewport top instead of anchoring its larger group', () => {
    const {scroller,surface,addAnchor} = scrollingSurface();
    const group=addAnchor({toolGroupId:'group'},200,1000);
    const event=addAnchor({eventId:'event'},430,100,group);
    addAnchor({toolId:'call'},430,100,event);
    surface.scrollTop=1400;
    expect(visibleReadingPosition(scroller)).toEqual({turnId:'target',offset:400,toolId:'call',eventId:'event',groupId:'group',anchorOffset:-30,groupAnchorOffset:200});
  });

  it('restores an event after content above it changes height without locking later scrolling', () => {
    const {scroller,surface,target,addAnchor} = scrollingSurface();
    target.dataset.turnReady='true';
    const event=addAnchor({eventId:'event'},400,600);
    surface.scrollTop=1450;
    const position=visibleReadingPosition(scroller)!;
    event.top=900;
    expect(restoreReadingPosition(scroller,position)).toBe(true);
    expect(surface.scrollTop).toBe(1950);
    surface.scrollTop=1800;
    event.top=1100;
    expect(surface.scrollTop).toBe(1800);
  });

  it('falls back to a collapsed group header, then to the saved turn offset when all anchors disappear', () => {
    const {scroller,surface,target,addAnchor} = scrollingSurface();
    target.dataset.turnReady='true';
    const group=addAnchor({toolGroupId:'group'},300,1000);
    const event=addAnchor({eventId:'event'},400,400,group);
    const tool=addAnchor({toolId:'call'},400,400,event);
    surface.scrollTop=1450;
    const position=visibleReadingPosition(scroller)!;
    event.height=0; tool.height=0; group.height=60;
    restoreReadingPosition(scroller,position);
    expect(surface.scrollTop).toBe(1300);
    group.height=0;
    restoreReadingPosition(scroller,position);
    expect(surface.scrollTop).toBe(1450);
  });

  it('restores negative offsets and clamps an offset when the same disclosure becomes shorter', () => {
    const {scroller,surface,target,addAnchor} = scrollingSurface();
    target.dataset.turnReady='true';
    const tool=addAnchor({toolId:'call'},400,400);
    restoreReadingPosition(scroller,{turnId:'target',offset:0,toolId:'call',anchorOffset:-30});
    expect(surface.scrollTop).toBe(1370);
    tool.height=70;
    restoreReadingPosition(scroller,{turnId:'target',offset:900,toolId:'call',anchorOffset:300});
    expect(surface.scrollTop).toBe(1430);
  });

  it('migrates a legacy standalone tool anchor to its exact collapsed group header', () => {
    const {scroller,surface,target,addAnchor} = scrollingSurface();
    target.dataset.turnReady = 'true';
    addAnchor({toolGroupId:'target:other-call'},100,34);
    addAnchor({toolGroupId:'target:call'},300,34);
    restoreReadingPosition(scroller,{turnId:'target',offset:1450,toolId:'call',eventId:'old-event',anchorOffset:250});
    expect(surface.scrollTop).toBe(1300);
    // A nonmatching first-call identity must retain the ordinary turn fallback.
    restoreReadingPosition(scroller,{turnId:'target',offset:450,toolId:'absent',anchorOffset:250});
    expect(surface.scrollTop).toBe(1450);
  });

  it('keeps a group below the viewport when its next visible tool disappears during collapse', () => {
    const {scroller,surface,target,addAnchor} = scrollingSurface();
    target.dataset.turnReady = 'true';
    const group = addAnchor({toolGroupId:'group'},600,1000);
    const tool = addAnchor({toolId:'call'},634,40,group);
    surface.scrollTop = 1400;
    const position = visibleReadingPosition(scroller)!;
    expect(position).toMatchObject({toolId:'call',anchorOffset:-234,groupAnchorOffset:-200});
    group.height = 34; tool.height = 0;
    restoreReadingPosition(scroller,position);
    expect(surface.scrollTop).toBe(1400);
    expect(group.getBoundingClientRect().top).toBe(200);
  });

  it('anchors a group heading at the viewport top instead of the commentary after it across repeated toggles', () => {
    const {scroller,surface,target,addAnchor} = scrollingSurface();
    target.dataset.turnReady = 'true';
    const group = addAnchor({toolGroupId:'target:call'},300,34);
    const heading = addAnchor({eventId:'tool-group-heading:target:call'},300,34,group);
    const commentary = addAnchor({eventId:'following-commentary'},354,300);
    surface.scrollTop = 1300;
    for (const height of [5034,34,5034,34]) {
      const position = visibleReadingPosition(scroller)!;
      expect(position).toMatchObject({eventId:'tool-group-heading:target:call',groupId:'target:call',anchorOffset:0});
      group.height = height; commentary.top = group.top + height + 20;
      restoreReadingPosition(scroller,position);
      expect(surface.scrollTop).toBe(1300);
      expect(heading.getBoundingClientRect().top).toBe(0);
    }
  });

  it('retains a group heading below the viewport while the reader is still in its preceding prompt', () => {
    const {scroller,surface,target,addAnchor} = scrollingSurface();
    target.dataset.turnReady = 'true';
    const group = addAnchor({toolGroupId:'target:call'},600,1034);
    const heading = addAnchor({eventId:'tool-group-heading:target:call'},600,34,group);
    const tool = addAnchor({toolId:'call'},634,40,group);
    const commentary = addAnchor({eventId:'following-commentary'},1654,300);
    surface.scrollTop = 1400;
    for (const height of [34,1034,34,1034]) {
      const position = visibleReadingPosition(scroller)!;
      expect(position).toEqual({turnId:'target',offset:400,eventId:'tool-group-heading:target:call',groupId:'target:call',anchorOffset:-200,groupAnchorOffset:-200});
      group.height = height; tool.height = height === 34 ? 0 : 40; commentary.top = group.top + height + 20;
      restoreReadingPosition(scroller,position);
      expect(surface.scrollTop).toBe(1400);
      expect(heading.getBoundingClientRect().top).toBe(200);
    }
  });

  it('does not drift when only the final few pixels of an unchanged anchor remain visible', () => {
    const {scroller,surface,target,addAnchor} = scrollingSurface();
    target.dataset.turnReady='true';
    addAnchor({eventId:'event'},400,100);
    surface.scrollTop=1490;
    const position=visibleReadingPosition(scroller)!;
    restoreReadingPosition(scroller,position);
    expect(surface.scrollTop).toBe(1490);
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

  it('recalibrates bulk layout changes without an initial coarse jump and remounts collapsed turns at their start', () => {
    const { scroller, surface, target, mount, addAnchor, moveTarget } = scrollingSurface();
    target.dataset.turnReady = 'true';
    const group = addAnchor({ toolGroupId: 'group' }, 300, 1000);
    const tool = addAnchor({ toolId: 'call' }, 1200, 100, group);
    surface.scrollTop = 2250;
    const position = visibleReadingPosition(scroller)!;
    expect(position.toolId).toBe('call');
    const ensureTurn = vi.fn(() => { mount(true); surface.scrollTop = 800; });
    const stopped = vi.fn();
    const navigation = locateReadingPosition(scroller, position, ensureTurn, stopped,
      { initialScroll: false, mountOffset: 0 });
    expect(ensureTurn).not.toHaveBeenCalled();
    // An earlier batch of collapsed rows moves this turn, and its own group hides the tool.
    moveTarget(800); group.height = 34; tool.height = 0; mount(false);
    vi.advanceTimersByTime(1);
    expect(ensureTurn).toHaveBeenLastCalledWith(0);
    navigation.layoutChanged(); vi.advanceTimersByTime(1);
    expect(surface.scrollTop).toBe(1100);
    vi.advanceTimersByTime(1800);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it.each(['wheel', 'pointerdown', 'touchstart'])('cancels a pending layout remount on %s', name => {
    const { scroller, surface, target, mount } = scrollingSurface();
    mount(false);
    const ensureTurn = vi.fn();
    const stopped = vi.fn();
    const navigation = locateReadingPosition(scroller, { turnId: 'target', offset: 10000 }, ensureTurn, stopped,
      { initialScroll: false, mountOffset: 0 });
    browser.dispatchEvent(new Event(name));
    mount(true); target.dataset.turnReady = 'true';
    navigation.layoutChanged(); vi.advanceTimersByTime(300);
    expect(ensureTurn).not.toHaveBeenCalled();
    expect(surface.scrollTop).toBe(0);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('lets a page navigation key interrupt layout restoration before an absent row remounts', () => {
    const { scroller, target, mount } = scrollingSurface();
    mount(false);
    const ensureTurn = vi.fn();
    const navigation = locateReadingPosition(scroller, { turnId: 'target', offset: 10000 }, ensureTurn, () => {},
      { initialScroll: false, mountOffset: 0 });
    const key = new Event('keydown'); Object.defineProperty(key, 'key', { value: 'PageDown' });
    browser.dispatchEvent(key);
    mount(true); target.dataset.turnReady = 'true';
    navigation.layoutChanged(); vi.advanceTimersByTime(300);
    expect(ensureTurn).not.toHaveBeenCalled();
  });

  it('waits for ready details before resolving a tool and keeps its identity through reflow', () => {
    const {scroller,surface,target,scrollToTurn,addAnchor} = scrollingSurface();
    const tool=addAnchor({toolId:'call'},400,400);
    const navigation=locateReadingPosition(scroller,{turnId:'target',offset:0,toolId:'call',anchorOffset:0},scrollToTurn,()=>{});
    vi.advanceTimersByTime(200);
    expect(surface.scrollTop).toBe(0);
    target.dataset.turnReady='true'; navigation.turnReady('target'); vi.advanceTimersByTime(1);
    expect(surface.scrollTop).toBe(1400);
    tool.top=750; navigation.layoutChanged(); vi.advanceTimersByTime(1);
    expect(surface.scrollTop).toBe(1750);
    browser.dispatchEvent(new Event('wheel'));
    tool.top=1000; navigation.layoutChanged(); vi.advanceTimersByTime(200);
    expect(surface.scrollTop).toBe(1750);
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
    const { scroller, surface, target } = scrollingSurface();
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
