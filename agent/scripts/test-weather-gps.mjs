import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const directory = mkdtempSync(path.join(tmpdir(), 'zaichang-weather-gps-'));
const compiled = path.join(directory, 'weather-gps.test.cjs');
try {
  await build({
    entryPoints: ['tests/weather-gps.test.ts'],
    bundle: true,
    outfile: compiled,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    loader: { '.md': 'text' },
  });
  const child = spawn(process.execPath, ['--test', '--test-timeout=30000', compiled], {
    stdio: 'inherit',
    windowsHide: true,
  });
  await new Promise((resolve) => child.on('exit', resolve));
  process.exitCode = child.exitCode ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
