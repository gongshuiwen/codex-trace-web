import type { CollaborationMessage } from '../shared/types.js';

/** Only call for an agent_message record, never for ordinary user/assistant prose. */
export function parseCollaborationMessage(text: string): CollaborationMessage | null {
  const header = /^Message Type:[ \t]*(MESSAGE|FINAL_ANSWER)[ \t]*\r?\nTask name:[ \t]*(\/[^\s]+)[ \t]*\r?\nSender:[ \t]*(\/[^\s]+)[ \t]*\r?\nPayload:[ \t]*(?:\r?\n)?([\s\S]*)$/.exec(text);
  if (!header) return null;
  return { messageType: header[1] as CollaborationMessage['messageType'], taskName: header[2]!, sender: header[3]!, payload: header[4]! };
}
