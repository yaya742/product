import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import electron from 'electron';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keep the legacy source-dev profile for its existing conversations, while
// the main process can also read a credential saved by the packaged profile.
// Developers can still override the directory for isolated work.
const devDataDir = process.env.ZAICHANG_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Zaichang', 'source-dev');
async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (/\.(?:ts|tsx|md)$/.test(entry.name)) files.push(full);
  }
  return files;
}
const electronOutputs = ['main.cjs', 'preload.cjs', 'plugin-runner.cjs'].map((name) => path.join(projectRoot, 'dist-electron', name));
const outputStats = await Promise.all(electronOutputs.map((file) => fs.stat(file).catch(() => undefined)));
const sources = [
  ...(await sourceFiles(path.join(projectRoot, 'src', 'main'))),
  ...(await sourceFiles(path.join(projectRoot, 'src', 'shared'))),
  path.join(projectRoot, 'prompts', 'system.md'),
];
const sourceStats = await Promise.all(sources.map((file) => fs.stat(file).catch(() => undefined)));
const needsElectronBuild = outputStats.some((stat) => !stat) || sourceStats.some((stat) => stat && outputStats.some((output) => !output || stat.mtimeMs > output.mtimeMs));
if (needsElectronBuild) {
  console.log('[在场] 检测到主进程源码更新，正在刷新 Electron bundle…');
  await import('./build-electron.mjs');
} else {
  console.log('[在场] Electron bundle 已是最新，跳过冷启动编译。');
}
const server = await createServer({
  root: projectRoot,
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Vite 8 normalizes `watch: null` to its default watcher. Explicitly
    // ignore every path: this shortcut is a cold-start launcher, not an HMR
    // session, and Windows should not crawl generated/test trees at all.
    watch: {
      ignored: ['**/*'],
    },
    hmr: false,
  },
});
await server.listen();
const devServerUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://127.0.0.1:5173';
const env = {
  ...process.env,
  ZAICHANG_DEV: '1',
  ZAICHANG_DEV_SERVER_URL: devServerUrl,
  ZAICHANG_DATA_DIR: devDataDir,
  ZAICHANG_DEBUG_ERRORS: process.env.ZAICHANG_DEBUG_ERRORS || '1',
  ZAICHANG_DEBUG_LOG: process.env.ZAICHANG_DEBUG_LOG || path.join(devDataDir, 'runtime-debug.log'),
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
let shuttingDown = false;
const closeServer = async (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close();
  process.exit(code);
};
child.on('error', (error) => {
  console.error('[在场] Electron 启动失败:', error.message);
  void closeServer(1);
});
child.on('exit', (code, signal) => {
  if (signal) console.log(`[在场] Electron 已退出（${signal}）`);
  void closeServer(code ?? 1);
});
process.on('SIGINT', () => {
  child.kill();
});
process.on('SIGTERM', () => {
  child.kill();
});
