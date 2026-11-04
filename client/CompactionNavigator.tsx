import { Minimize2 } from 'lucide-react';
import type { CompactionItem } from '../shared/types';
import { clock } from './format';
import { SessionRecordNavigator, type SessionRecordNavigatorProps } from './SessionRecordNavigator';

const config = {
  kind: 'compaction' as const,
  endpoint: '/compactions',
  label: '压缩记录',
  empty: '当前会话没有已记录的上下文压缩',
  icon: Minimize2,
  getItemId: (item: CompactionItem) => item.eventId,
  describeItem: (item: CompactionItem) => clock(item.timestamp),
};

export function CompactionNavigator(props: SessionRecordNavigatorProps<CompactionItem>) {
  return <SessionRecordNavigator {...props} config={config} />;
}
