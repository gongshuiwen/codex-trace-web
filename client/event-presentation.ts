import type { TimelineEvent } from '../shared/types';
import type { ToolTimelineEntry } from './tool-groups';

export interface ContextGroup {
  kind: 'context-group';
  id: string;
  events: TimelineEvent[];
}

/** Wrap every consecutive context run without moving or changing recorded events. */
export function groupAdjacentContexts(events: readonly ToolTimelineEntry[]): (ToolTimelineEntry | ContextGroup)[] {
  const entries: (ToolTimelineEntry | ContextGroup)[] = [];
  let pending: ContextGroup | undefined;
  for (const event of events) {
    if (event.kind === 'context') {
      if (!pending) {
        pending = { kind: 'context-group', id: event.id, events: [] };
        entries.push(pending);
      }
      pending.events.push(event);
    } else {
      pending = undefined;
      entries.push(event);
    }
  }
  return entries;
}

const agentsHeading = /^#{1,6}\s+AGENTS\.md instructions[ \t]*(?:\r?\n|$)/i;
const skillsHeading = /^#{1,6}\s+Skills[ \t]*(?:\r?\n|$)/i;
const instructionsHeading = /^#{1,6}\s+(?:System|Developer) instructions[ \t]*(?:\r?\n|$)/i;
const projectTag = /^<(?:INSTRUCTIONS|user_instructions)>/i;
const skillsTag = /^<skills_instructions>/i;
const environmentTag = /^<environment_context>/i;
const instructionsTag = /^<(?:system|developer|system_instructions|developer_instructions|permissions instructions)>/i;
const classificationTags = /<\/?(?:INSTRUCTIONS|user_instructions|skills_instructions|environment_context|system|developer|system_instructions|developer_instructions|permissions instructions)>/gi;

/** Labels rely on explicit text markers: the timeline does not retain message roles. */
export function contextPresentation(event: TimelineEvent): { label: string; preview: string } {
  let text = event.text.trim();
  let label = '附带上下文';
  if (agentsHeading.test(text) || projectTag.test(text)) label = '项目指令';
  else if (skillsTag.test(text) || skillsHeading.test(text)) label = 'Skills';
  else if (environmentTag.test(text)) label = '环境信息';
  else if (instructionsTag.test(text) || instructionsHeading.test(text)) label = '系统 / 开发者指令';

  if (label !== '附带上下文') {
    text = text.replace(agentsHeading, '').replace(skillsHeading, '').replace(instructionsHeading, '').replace(classificationTags, '');
  }
  const characters = Array.from(text.replace(/\s+/g, ' ').trim());
  return { label, preview: characters.length > 100 ? `${characters.slice(0, 99).join('')}…` : characters.join('') };
}
