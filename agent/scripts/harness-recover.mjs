import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve('.test-data/recovery-tool');
fs.mkdirSync(root, { recursive: true });
const entry = path.join(root, 'recover.cjs');
await build({
  entryPoints: ['scripts/harness-recover.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: entry,
  loader: { '.md': 'text' },
});
const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
});
process.exitCode = result.status ?? 1;

