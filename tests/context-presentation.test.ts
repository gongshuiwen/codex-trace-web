import { describe, expect, it } from 'vitest';
import type { ContextComponent } from '../shared/types';
import { contextRow, signedContextTokens } from '../client/context-presentation';

const component: ContextComponent = { id: 'toolOutputs', label: '工具输出', tokens: 250, status: 'estimated', method: 'tokenized', items: 1, note: '可见输出' };

describe('context estimate presentation', () => {
  it('keeps unknown values distinct from a measured zero', () => {
    expect(contextRow({ ...component, tokens: null, status: 'unavailable', method: 'none' }, 1000)).toMatchObject({ value: '未知', state: '无法统计', percent: null });
    expect(contextRow({ ...component, tokens: 0 }, 1000)).toMatchObject({ value: '≈ 0', percent: 0, percentLabel: '0.0%' });
  });

  it('uses actual input as the common denominator and does not normalize excess', () => {
    expect(contextRow(component, 1000)).toMatchObject({ percent: 25, percentLabel: '25.0%' });
    expect(contextRow({ ...component, tokens: 1600 }, 1000)).toMatchObject({ percent: 160, percentLabel: '160.0%' });
    expect(signedContextTokens(-600)).toBe('-600');
  });

  it('does not invent a percentage for an unavailable input denominator', () => {
    expect(contextRow(component, 0)).toMatchObject({ percent: null, percentLabel: null });
    expect(signedContextTokens(null)).toBe('无法对账');
    expect(contextRow({ ...component, tokens: 50, status: 'partial', method: 'sampled' }, 1000).state).toBe('部分估算');
  });
});
