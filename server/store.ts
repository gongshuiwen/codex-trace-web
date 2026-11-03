import { DatabaseSync } from 'node:sqlite';
import type { IndexedSession } from './parser-types.js';
import type { IndexProgress, SessionChildrenPage, SessionDetail, SessionList, SessionSummary } from '../shared/types.js';

// Bump when parser semantics change so unchanged source files are reindexed.
export const INDEX_SCHEMA_VERSION = 3;

export interface ListOptions {
  query?: string;
  project?: string;
  cursor?: number;
  limit?: number;
  selectedId?: string;
}

interface SummaryRow {
  id: string;
  summary_json: string;
  child_count?: number;
}

interface SessionRow extends SummaryRow {
  id: string;
  file_path: string;
  size: number;
  mtime_ms: number;
  turns_json: string;
}

const summaryFields = `s.id, s.summary_json,
  (SELECT COUNT(*) FROM sessions child WHERE child.parent_id = s.id AND child.id != s.id) AS child_count`;

function summary(row: SummaryRow): SessionSummary {
  return { ...JSON.parse(row.summary_json), ...(row.child_count !== undefined ? { childCount: Number(row.child_count) } : {}) } as SessionSummary;
}

function escapedLike(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

function messageSearch(query: string): { sql: string; parameters: string[] } {
  const like = escapedLike(query);
  // Trigrams make long-body search indexed, including Chinese substrings.
  // Queries shorter than three Unicode characters need a literal LIKE scan.
  if ([...query].length >= 3 && !query.includes('\0')) {
    return { sql: `text MATCH ? AND text LIKE ? ESCAPE '\\'`, parameters: [`"${query.replace(/"/g, '""')}"`, like] };
  }
  return { sql: `text LIKE ? ESCAPE '\\'`, parameters: [like] };
}

export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        updated_at TEXT NOT NULL,
        cwd TEXT NOT NULL,
        project TEXT NOT NULL,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        parent_id TEXT,
        summary_json TEXT NOT NULL,
        turns_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS sessions_project ON sessions(cwd);
      CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
        session_id UNINDEXED, turn_id UNINDEXED, text, tokenize='trigram'
      );
    `);
    const version = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    if (!version) this.db.prepare('INSERT INTO schema_version VALUES (?)').run(INDEX_SCHEMA_VERSION);
    if (version && version.version !== INDEX_SCHEMA_VERSION) throw new Error('索引缓存版本不兼容，请删除索引缓存后重试。');
  }

  close(): void {
    this.db.close();
  }

  fingerprint(path: string): { size: number; mtimeMs: number } | null {
    const row = this.db.prepare('SELECT size, mtime_ms FROM sessions WHERE file_path = ?').get(path) as
      { size: number; mtime_ms: number } | undefined;
    return row ? { size: row.size, mtimeMs: row.mtime_ms } : null;
  }

  upsert(data: IndexedSession, path: string, size: number, mtimeMs: number): void {
    // Standard Codex rollout names carry the owning session UUID. A replayed
    // parent session_meta must never silently overwrite that parent's mapping.
    const filenameId = /(?:^|[\\/])rollout-[^\\/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1];
    if (filenameId && filenameId.toLowerCase() !== data.session.id.toLowerCase()) {
      throw new Error('日志会话标识与 rollout 文件名不一致，已跳过以保护会话索引。');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT id FROM sessions WHERE file_path = ?').get(path) as { id: string } | undefined;
      if (previous && previous.id !== data.session.id) {
        this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(previous.id);
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(previous.id);
      }
      const s = data.session;
      this.db.prepare(`INSERT INTO sessions
        (id,file_path,size,mtime_ms,updated_at,cwd,project,title,model,parent_id,summary_json,turns_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          file_path=excluded.file_path, size=excluded.size, mtime_ms=excluded.mtime_ms,
          updated_at=excluded.updated_at,cwd=excluded.cwd,project=excluded.project,
          title=excluded.title,model=excluded.model,parent_id=excluded.parent_id,
          summary_json=excluded.summary_json,turns_json=excluded.turns_json
      `).run(s.id, path, size, mtimeMs, s.updatedAt, s.cwd, s.project, s.title, s.model,
        s.parentId ?? null, JSON.stringify({ ...s, filePath: path }), JSON.stringify(data.turns));
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(s.id);
      const insertMessage = this.db.prepare('INSERT INTO messages (session_id,turn_id,text) VALUES (?,?,?)');
      for (const message of data.searchMessages) {
        if (message.text) insertMessage.run(s.id, message.turnId, message.text);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  removePath(path: string): string | null {
    const row = this.db.prepare('SELECT id FROM sessions WHERE file_path = ?').get(path) as { id: string } | undefined;
    if (!row) return null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(row.id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return row.id;
  }

  paths(): string[] {
    return (this.db.prepare('SELECT file_path FROM sessions').all() as { file_path: string }[]).map(row => row.file_path);
  }

  getPath(id: string): string | null {
    const row = this.db.prepare('SELECT file_path FROM sessions WHERE id = ?').get(id) as { file_path: string } | undefined;
    return row?.file_path ?? null;
  }

  get(id: string): SessionDetail | null {
    const row = this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM sessions child WHERE child.parent_id = s.id AND child.id != s.id) AS child_count
      FROM sessions s WHERE s.id = ?`).get(id) as SessionRow | undefined;
    if (!row) return null;
    const session = summary(row);
    const parent = session.parentId && session.parentId !== id
      ? this.getSummary(session.parentId)
      : undefined;
    const children = this.db.prepare(`SELECT ${summaryFields} FROM sessions s WHERE s.parent_id = ? AND s.id != ? ORDER BY s.updated_at DESC, s.id ASC`)
      .all(id, id) as unknown as SummaryRow[];
    return {
      session,
      turns: JSON.parse(row.turns_json),
      children: children.map(summary),
      ...(parent ? { parent } : {}),
    };
  }

  private getSummary(id: string): SessionSummary | undefined {
    const row = this.db.prepare(`SELECT ${summaryFields} FROM sessions s WHERE s.id = ?`).get(id) as SummaryRow | undefined;
    return row ? summary(row) : undefined;
  }

  children(id: string, options: Pick<ListOptions, 'cursor' | 'limit'> = {}): SessionChildrenPage | null {
    if (!this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) return null;
    const cursor = Math.max(0, Math.trunc(options.cursor ?? 0));
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 50)));
    const total = Number((this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE parent_id = ? AND id != ?').get(id, id) as { count: number }).count);
    const rows = this.db.prepare(`SELECT ${summaryFields} FROM sessions s WHERE s.parent_id = ? AND s.id != ?
      ORDER BY s.updated_at DESC, s.id ASC LIMIT ? OFFSET ?`).all(id, id, limit, cursor) as unknown as SummaryRow[];
    return { items: rows.map(summary), total, nextCursor: cursor + rows.length < total ? cursor + rows.length : null };
  }

  private ancestorsOf(items: SessionSummary[]): SessionSummary[] {
    const visible = new Set(items.map(item => item.id));
    const ancestors = new Map<string, SessionSummary>();
    const examined = new Set<string>();
    for (const item of items) {
      let parentId = item.parentId;
      while (parentId && !examined.has(parentId)) {
        examined.add(parentId);
        const parent = this.getSummary(parentId);
        if (!parent) break;
        if (!visible.has(parent.id)) ancestors.set(parent.id, parent);
        parentId = parent.parentId;
      }
    }
    return [...ancestors.values()];
  }

  list(options: ListOptions, progress: IndexProgress): SessionList {
    const query = options.query?.trim().slice(0, 1000) ?? '';
    const cursor = Math.max(0, Math.trunc(options.cursor ?? 0));
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 50)));
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (options.project) {
      conditions.push('s.cwd = ?');
      parameters.push(options.project);
    }
    if (query) {
      const like = escapedLike(query);
      const body = messageSearch(query);
      conditions.push(`(s.title LIKE ? ESCAPE '\\' OR s.cwd LIKE ? ESCAPE '\\'
        OR s.model LIKE ? ESCAPE '\\' OR s.id LIKE ? ESCAPE '\\'
        OR json_extract(s.summary_json, '$.agentName') LIKE ? ESCAPE '\\'
        OR json_extract(s.summary_json, '$.agentNickname') LIKE ? ESCAPE '\\'
        OR s.id IN (SELECT session_id FROM messages WHERE ${body.sql}))`);
      parameters.push(like, like, like, like, like, like, ...body.parameters);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM sessions s ${where}`).get(...parameters) as { count: number }).count);
    const rows = this.db.prepare(`SELECT ${summaryFields} FROM sessions s ${where} ORDER BY s.updated_at DESC, s.id ASC LIMIT ? OFFSET ?`)
      .all(...parameters, limit, cursor) as unknown as SummaryRow[];
    const items = rows.map(row => {
      const value = summary(row);
      if (query) {
        const body = messageSearch(query);
        const match = this.db.prepare(`SELECT turn_id, text FROM messages WHERE session_id = ? AND ${body.sql} LIMIT 1`)
          .get(row.id, ...body.parameters) as { turn_id: string; text: string } | undefined;
        if (match) {
          const at = match.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
          const start = Math.max(0, at - 50);
          value.match = { turnId: match.turn_id, excerpt: `${start ? '…' : ''}${match.text.slice(start, start + 220)}${match.text.length > start + 220 ? '…' : ''}` };
        }
      }
      return value;
    });
    const projects = (this.db.prepare(`SELECT cwd AS path, project AS name, COUNT(*) AS count FROM sessions
      GROUP BY cwd ORDER BY COUNT(*) DESC, cwd ASC`).all() as { path: string; name: string; count: number }[])
      .map(row => ({ ...row, count: Number(row.count) }));
    const selected = !query && !options.project && options.selectedId ? this.getSummary(options.selectedId) : undefined;
    const ancestors = this.ancestorsOf(selected ? [...items, selected] : items);
    return { items, total, nextCursor: cursor + items.length < total ? cursor + items.length : null, projects, progress,
      ancestors, ...(selected ? { selected } : {}) };
  }
}
