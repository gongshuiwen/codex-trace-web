import type { TimelineEvent } from '../shared/types';

/** Pull the first user message into the request card, preserving all later events. */
export function turnPresentation(summaryPrompt: string, events: readonly TimelineEvent[] = []) {
  const firstUserIndex = events.findIndex(event => event.kind === 'user');
  return {
    prompt: firstUserIndex >= 0 ? events[firstUserIndex]!.text : summaryPrompt,
    timeline: events.filter((_, index) => index !== firstUserIndex),
  };
}
