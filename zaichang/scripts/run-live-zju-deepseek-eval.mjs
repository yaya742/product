import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outfile = path.join(os.tmpdir(), `zaichang-live-zju-eval-${process.pid}.cjs`);
await build({
  entryPoints: ['scripts/live-zju-deepseek-eval.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile,
  loader: { '.md': 'text' },
});
try {
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', windowsHide: true, env: process.env });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(outfile, { force: true });
}
