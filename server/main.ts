import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { readSettings, saveSettings } from './config.js';
import { IndexService } from './indexer.js';

const settings = await readSettings();
const index = new IndexService({ sessionsDir: settings.sessionsDir, dataDir: settings.dataDir });
await index.start();
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
const app = await createApp({ index, settings, saveSettings, clientDir, logger: true });
const port = Number(process.env.SESSION_LENS_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SESSION_LENS_PORT 必须是有效端口。');
try {
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`\n会话观察台已启动：http://127.0.0.1:${port}\n日志目录：${settings.sessionsDir}\n`);
} catch (error) {
  await index.stop();
  throw error;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await index.stop();
}
process.on('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void stop().then(() => process.exit(0)); });
