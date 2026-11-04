import { describe, expect, it } from 'vitest';
import { MAX_TOOL_OUTPUT_POSITIONS, parseToolOutputPositions, serializeToolOutputPositions, type ToolOutputPosition } from '../client/tool-output-position';

const position = (overrides: Partial<ToolOutputPosition> = {}): ToolOutputPosition => ({ sessionId: 'session', toolId: 'call', offset: 20_688, length: 16_384, scroll: { raw: 2714.5, result: 0 }, ...overrides });

describe('tool output position metadata', () => {
  it('round trips the output range and per-tab scroll without serializing log text', () => {
    const value = { ...position(), text: 'secret log output', arguments: 'secret arguments' };
    const serialized = serializeToolOutputPositions([value]);
    expect(parseToolOutputPositions(serialized)).toEqual([position()]);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('arguments');
  });

  it('ignores malformed stores and incompatible versions', () => {
    expect(parseToolOutputPositions(null)).toEqual([]);
    expect(parseToolOutputPositions('{bad JSON')).toEqual([]);
    expect(parseToolOutputPositions(JSON.stringify({ version: 2, entries: [position()] }))).toEqual([]);
    expect(parseToolOutputPositions('x'.repeat(1_048_577))).toEqual([]);
  });

  it('rejects invalid identifiers, offsets, lengths, and scroll values while preserving valid entries', () => {
    const invalid = [
      position({ sessionId: '' }), position({ toolId: '\u0000call' }), position({ toolId: 'x'.repeat(257) }),
      position({ offset: -1 }), position({ offset: 1.5 }), position({ offset: Number.MAX_SAFE_INTEGER }),
      position({ length: 262_145 }), position({ length: -2 }), position({ scroll: { raw: -1 } }),
      position({ scroll: { raw: Infinity } }), position({ scroll: { raw: 1_000_000_001 } }),
      { ...position(), scroll: { unknown: 2 } }, { ...position(), scroll: [] },
    ];
    const parsed = parseToolOutputPositions(JSON.stringify({ version: 1, entries: [...invalid, position({ toolId: 'valid' })] }));
    expect(parsed).toEqual([position({ toolId: 'valid' })]);
  });

  it('keeps the newest metadata for duplicate identities and isolates sessions', () => {
    const serialized = serializeToolOutputPositions([position(), position({ sessionId: 'another' }), position({ offset: 25_000, scroll: { raw: 50 } })]);
    const parsed = parseToolOutputPositions(serialized);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].sessionId).toBe('another');
    expect(parsed[1].offset).toBe(25_000);
    expect(parsed[1].scroll).toEqual({ raw: 50 });
  });

  it('bounds retained entries and returns detached metadata objects', () => {
    const saved = Array.from({ length: MAX_TOOL_OUTPUT_POSITIONS + 1 }, (_, index) => position({ toolId: String(index) }));
    const serialized = serializeToolOutputPositions(saved);
    const parsed = parseToolOutputPositions(serialized);
    expect(parsed).toHaveLength(MAX_TOOL_OUTPUT_POSITIONS);
    expect(parsed[0].toolId).toBe('1');
    parsed[0].scroll.raw = 999;
    expect(parseToolOutputPositions(serialized)[0].scroll.raw).toBe(2714.5);
  });
});
