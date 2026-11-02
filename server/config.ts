import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { AppSettings } from '../shared/types.js';

export function getDataDir(): string {
  return path.resolve(process.env.SESSION_LENS_DATA_DIR || path.join(
    process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'share'), 'codex-session-lens',
  ));
}

export async function readSettings(): Promise<AppSettings> {
  const dataDir = getDataDir();
  const defaultSessionsDir = path.resolve(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions');
  let saved: { sessionsDir?: string } = {};
  try {
    saved = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('本地设置无法读取，使用默认日志目录。');
  }
  const sessionsDir = path.resolve(process.env.SESSION_LENS_SESSIONS_DIR || saved.sessionsDir || defaultSessionsDir);
  return { sessionsDir, defaultSessionsDir, dataDir };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await mkdir(settings.dataDir, { recursive: true });
  const target = path.join(settings.dataDir, 'settings.json');
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify({ sessionsDir: settings.sessionsDir }, null, 2), 'utf8');
  await rename(temporary, target);
}
