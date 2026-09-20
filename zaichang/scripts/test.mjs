import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { isolatedEnvironment } from './test-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const env = isolatedEnvironment('core');
const compiled = path.join(env.ZAICHANG_DATA_DIR, 'core.test.cjs');
const report = path.resolve(process.env.ZAICHANG_CORE_REPORT || 'artifacts/understanding-action/core-current');
fs.mkdirSync(report, { recursive: true });
await build({
  entryPoints: ['tests/core.test.ts'],
  bundle: true,
  outfile: compiled,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  loader: { '.md': 'text' },
});
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=120000', ...(process.env.ZAICHANG_CORE_FILTER ? ['--test-name-pattern', process.env.ZAICHANG_CORE_FILTER] : []), compiled], { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
let output = '';
for (const channel of [child.stdout, child.stderr]) channel.on('data', chunk => { output += chunk.toString(); process.stdout.write(chunk); });
child.on('exit', code => {
  fs.writeFileSync(path.join(report, 'core.tap'), output);
  fs.writeFileSync(path.join(report, 'report.json'), JSON.stringify({ status: code === 0 ? 'passed' : 'failed', filter: process.env.ZAICHANG_CORE_FILTER || null, exitCode: code, compiledSha256: createHash('sha256').update(fs.readFileSync(compiled)).digest('hex'), at: new Date().toISOString(), dataDirectory: env.ZAICHANG_DATA_DIR }, null, 2));
  process.exit(code ?? 1);
});
