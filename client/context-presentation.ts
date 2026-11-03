import type { ContextComponent } from '../shared/types';

const states: Record<ContextComponent['status'], string> = {
  estimated: '估算',
  partial: '部分估算',
  unavailable: '无法统计',
};

export function contextRow(component: ContextComponent, inputTokens: number) {
  const known = component.tokens != null && component.status !== 'unavailable';
  const percent = known && inputTokens > 0 ? component.tokens! / inputTokens * 100 : null;
  return {
    value: known ? `≈ ${component.tokens!.toLocaleString('zh-CN')}` : '未知',
    state: states[component.status],
    percent,
    percentLabel: percent == null ? null : `${percent < 0.1 && percent > 0 ? '<0.1' : percent.toFixed(1)}%`,
  };
}

export function signedContextTokens(value: number | null) {
  return value == null ? '无法对账' : value.toLocaleString('zh-CN');
}

export function signedTokenDelta(value: number | null, estimated = false) {
  return value == null ? '无法比较' : `${estimated ? '≈ ' : ''}${value > 0 ? '+' : ''}${value.toLocaleString('zh-CN')}`;
}
