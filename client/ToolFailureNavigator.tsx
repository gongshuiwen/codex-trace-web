import { CircleX } from 'lucide-react';
import type { ToolFailureItem } from '../shared/types';
import { SessionRecordNavigator, type SessionRecordNavigatorProps } from './SessionRecordNavigator';

const config = {
  kind: 'failure' as const,
  endpoint: '/tools/failures',
  label: '失败调用',
  empty: '当前会话没有已记录的失败调用',
  icon: CircleX,
  getItemId: (item: ToolFailureItem) => item.toolId,
  describeItem: (item: ToolFailureItem) => item.toolName,
};

export function ToolFailureNavigator(props: SessionRecordNavigatorProps<ToolFailureItem>) {
  return <SessionRecordNavigator {...props} config={config} />;
}
