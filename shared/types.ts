export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface RequestUsage {
  id: string;
  turnId: string;
  timestamp: string;
  usage: TokenUsage;
  source: 'record' | 'snapshot-delta';
  model?: string;
  contextWindow?: number;
}

export interface SessionActivity {
  requests: RequestUsage[];
  compactions: { id: string; turnId?: string; timestamp: string; beforeRequestIndex: number }[];
  messages: { id: string; turnId: string; timestamp: string; messageType: CollaborationMessage['messageType']; sender: string; taskName: string; preview: string }[];
  warnings: string[];
}

export type ContextCategory = 'userMessages' | 'projectInstructions' | 'skills' | 'toolDefinitions' | 'toolOutputs' | 'other';

export interface ContextComponent {
  id: ContextCategory;
  label: string;
  tokens: number | null;
  status: 'estimated' | 'partial' | 'unavailable';
  method: 'tokenized' | 'sampled' | 'none';
  items: number;
  note: string;
}

export interface RequestContextAnalysis {
  requestId: string;
  inputTokens: number;
  tokenizer: 'o200k_base';
  boundary: 'inferred' | 'unavailable';
  scope: 'visible-history' | 'since-compaction' | 'unavailable';
  components: ContextComponent[];
  estimatedTotalTokens: number | null;
  unattributedTokens: number | null;
  excessTokens: number;
  warnings: string[];
}

export interface ContextSource {
  id: string;
  category: ContextCategory;
  turnId?: string;
  eventId?: string;
  label: string;
  role?: string;
  estimatedTokens: number;
  method: 'tokenized' | 'sampled';
  partial: boolean;
  note: string;
  excerpt: string;
}

export interface ContextSourcePage {
  requestId: string;
  category: ContextCategory;
  sources: ContextSource[];
  total: number;
  nextOffset: number | null;
  boundary: RequestContextAnalysis['boundary'];
  scope: RequestContextAnalysis['scope'];
  warnings: string[];
}

export interface RequestContextComparison {
  current: RequestUsage;
  previous: RequestUsage | null;
  comparable: boolean;
  components: {
    id: ContextCategory;
    label: string;
    currentTokens: number | null;
    previousTokens: number | null;
    deltaTokens: number | null;
  }[];
  changes: {
    added: number;
    removed: number;
    changed: number;
    addedSources: ContextSource[];
    removedSources: ContextSource[];
    changedSources: ContextSource[];
  };
  warnings: string[];
}

export interface UsageSummary {
  tokens: TokenUsage | null;
  requestCount: number;
  completeness: 'complete' | 'partial' | 'unknown';
  latestInputTokens: number | null;
  contextWindow: number | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  project: string;
  model: string;
  branch?: string;
  source: string;
  startedAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'interrupted' | 'unknown';
  turnCount: number;
  toolCount: number;
  parentId?: string;
  agentName?: string;
  agentNickname?: string;
  childCount?: number;
  filePath: string;
  fileSize: number;
  revision: string;
  usage: UsageSummary;
  parseErrors: number;
  match?: { turnId: string; excerpt: string };
}

export interface TurnSummary {
  id: string;
  index: number;
  prompt: string;
  preview: string;
  startedAt: string;
  endedAt?: string;
  status: SessionSummary['status'];
  model: string;
  toolCount: number;
  usage: UsageSummary;
  startOffset: number;
  endOffset: number;
}

export type TimelineKind = 'user' | 'assistant' | 'commentary' | 'context' | 'reasoning' | 'tool' | 'collaboration' | 'notice' | 'unknown';

export interface CollaborationMessage {
  messageType: 'NEW_TASK' | 'MESSAGE' | 'FINAL_ANSWER';
  taskName: string;
  sender: string;
  payload: string;
}

export interface ToolCall {
  id: string;
  name: string;
  category: 'command' | 'mcp' | 'patch' | 'web' | 'agent' | 'other';
  arguments: string;
  output: string;
  outputLength: number;
  outputTruncated: boolean;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  exitCode?: number;
}

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  timestamp: string;
  text: string;
  tool?: ToolCall;
  collaboration?: CollaborationMessage;
}

export interface TurnDetail {
  summary: TurnSummary;
  events: TimelineEvent[];
  requests: RequestUsage[];
  warnings: string[];
}

export interface SessionDetail {
  session: SessionSummary;
  turns: TurnSummary[];
  children: SessionSummary[];
  parent?: SessionSummary;
}

export interface IndexProgress {
  status: 'scanning' | 'ready' | 'error';
  discovered: number;
  indexed: number;
  errors: number;
  message?: string;
}

export interface SessionList {
  items: SessionSummary[];
  ancestors?: SessionSummary[];
  selected?: SessionSummary;
  total: number;
  nextCursor: number | null;
  projects: { name: string; path: string; count: number }[];
  progress: IndexProgress;
}

export interface SessionChildrenPage {
  items: SessionSummary[];
  total: number;
  nextCursor: number | null;
}

export interface AppSettings {
  sessionsDir: string;
  defaultSessionsDir: string;
  dataDir: string;
}

export interface LiveEvent {
  type: 'index-progress' | 'sessions-changed' | 'session-changed' | 'ready';
  sessionId?: string;
  revision?: string;
  progress?: IndexProgress;
}

export interface OutputPage {
  text: string;
  offset: number;
  nextOffset: number | null;
  totalLength: number;
}
