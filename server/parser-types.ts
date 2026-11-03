import type { SessionSummary, TurnSummary, TurnDetail, OutputPage, SessionActivity } from '../shared/types.js';

export interface IndexedSession {
  session: SessionSummary;
  turns: TurnSummary[];
  searchMessages: { turnId: string; text: string }[];
}

// Parser implementation exports these functions. Source logs are always read-only.
export interface ParserContract {
  indexSessionFile(path: string): Promise<IndexedSession>;
  loadTurnDetail(path: string, turnId: string): Promise<TurnDetail>;
  loadToolOutput(path: string, callId: string, offset: number, limit: number): Promise<OutputPage>;
  loadSessionActivity(path: string): Promise<SessionActivity>;
}
