import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { isolatedEnvironment } from './test-environment.mjs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2),
  option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
const suite = option('--suite', 'unit'),
  seed = Number(option('--seed', '7421'));
const files = fs
  .readdirSync('tests/harness')
  .filter((f) => f.endsWith('.test.ts') && (suite === 'all' || f === suite + '.test.ts'));
if (!files.length) throw new Error('No implemented test suite: ' + suite);
const env = isolatedEnvironment('harness-' + suite);
env.ZAICHANG_TEST_LAYER = option('--layer', 'all');
env.ZAICHANG_TEST_SEED = String(seed);
const out = path.resolve(
  option(
    '--report-dir',
    path.join('artifacts/harness', new Date().toISOString().replace(/[:.]/g, '-') + '-' + suite),
  ),
);
fs.mkdirSync(out, { recursive: true });
const results = [];
const startedAt = new Date().toISOString();
let failed = false;
env.ZAICHANG_CASE_REPORT = path.join(out, 'scenarios');
if (files.includes('scenarios.test.ts') && env.ZAICHANG_TEST_LAYER !== 'backend') {
  const built =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm run build'], {
          env,
          encoding: 'utf8',
          windowsHide: true,
        })
      : spawnSync('npm', ['run', 'build'], { env, encoding: 'utf8' });
  fs.writeFileSync(path.join(out, 'application-build.log'), built.stdout + '\n' + built.stderr);
  if (built.status !== 0) throw new Error('Application build failed before real-entry acceptance.');
}
for (const file of files) {
  const suiteStarted = performance.now();
  const compiled = path.join(env.ZAICHANG_DATA_DIR, file.replace('.ts', '.cjs'));
  await build({
    entryPoints: [path.join('tests/harness', file)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: compiled,
    loader: { '.md': 'text' },
    external: ['esbuild'],
  });
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', compiled], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16_000_000,
  });
  const output = result.stdout + '\n' + result.stderr;
  fs.writeFileSync(path.join(out, file + '.tap'), output);
  const cases = [...output.matchAll(/^(not ok|ok) \d+ - (.+)$/gm)].map((m) => ({
    name: m[2],
    status: m[1] === 'ok' ? 'passed' : 'failed',
  }));
  const skipped = /# SKIP|# TODO/.test(output);
  const status = result.status === 0 && !skipped && cases.length ? 'passed' : 'failed';
  const latencySamplesMs = [...output.matchAll(/duration_ms: ([\d.]+)/g)].map((m) => Number(m[1]));
  results.push({
    file,
    compiledSha256: createHash('sha256').update(fs.readFileSync(compiled)).digest('hex'),
    sidecarSha256: fs.existsSync('runtime/hermes/sidecar.py') ? createHash('sha256').update(fs.readFileSync('runtime/hermes/sidecar.py')).digest('hex') : null,
    status,
    exitCode: result.status,
    signal: result.signal,
    cases,
    skipped,
    durationMs: performance.now() - suiteStarted,
    latencySamplesMs,
  });
  failed ||= status !== 'passed';
  console.log(`${file}: ${status} (${cases.filter((c) => c.status === 'passed').length}/${cases.length})`);
  if (status !== 'passed')
    console.log(
      cases
        .filter((c) => c.status === 'failed')
        .map((c) => c.name)
        .join('\n') || output.slice(-4000),
    );
}
fs.writeFileSync(
  path.join(out, 'tests.json'),
  JSON.stringify(
    {
      status: failed ? 'failed' : 'passed',
      kind: 'deterministic_mechanism',
      suite,
      layer: env.ZAICHANG_TEST_LAYER,
      startedAt,
      finishedAt: new Date().toISOString(),
      seed,
      node: process.version,
      platform: process.platform,
      dataDirectory: env.ZAICHANG_DATA_DIR,
      command: process.argv.slice(1),
      results,
    },
    null,
    2,
  ),
);
console.log('Report: ' + out);
if (failed) process.exitCode = 1;
