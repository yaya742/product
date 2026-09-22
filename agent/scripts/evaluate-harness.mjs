import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { isolatedEnvironment } from './test-environment.mjs';
const live = process.argv.includes('--live'),
  lunaTest = process.env.ZAICHANG_MODEL_TRANSPORT === 'luna-app-server-test',
  understandingProtocol = process.argv.includes('--understanding-protocol'),
  understandingSlice = process.argv.includes('--understanding-slice'),
  understandingControls = process.argv.includes('--understanding-controls'),
  understandingDelegation = process.argv.includes('--understanding-delegation'),
  understandingStories = process.argv.includes('--understanding-stories'),
  understandingLongTail = process.argv.includes('--understanding-long-tail'),
  understandingJudgeReplay = process.argv.includes('--understanding-judge-replay'),
  understandingComparison = process.argv.includes('--understanding-comparison'),
  understandingAblations = process.argv.includes('--understanding-ablations'),
  out = path.resolve(
    process.env.ZAICHANG_EVAL_REPORT ||
      (understandingProtocol ? 'artifacts/understanding-action/protocol-live' : understandingSlice ? 'artifacts/understanding-action/slice-live' : understandingControls ? 'artifacts/understanding-action/controls-live' : understandingDelegation ? 'artifacts/understanding-action/delegation-live' : 'artifacts/harness/' + (live ? 'live-evaluation' : 'offline-evaluation')),
  );
fs.mkdirSync(out, { recursive: true });
if (live && understandingAblations) {
  const result = spawnSync(process.execPath, ['scripts/run-understanding-ablations.mjs'], { env: process.env, stdio: 'inherit', windowsHide: true });
  process.exitCode = result.status ?? 1;
} else if (live && understandingComparison) {
  const result = spawnSync(process.execPath, ['scripts/run-understanding-comparison.mjs'], { env: process.env, stdio: 'inherit', windowsHide: true });
  process.exitCode = result.status ?? 1;
} else if (live) {
  if (process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1' || (!lunaTest && !process.env.ZAICHANG_TEST_DEEPSEEK_KEY)) {
    fs.writeFileSync(
      path.join(out, 'live.json'),
      JSON.stringify(
        {
          status: 'not_run',
          kind: 'real_model',
          reason:
            'Requires ZAICHANG_ALLOW_LIVE_EVAL=1 and separately supplied ZAICHANG_TEST_DEEPSEEK_KEY. Production credentials are never read.',
          model: 'deepseek-flash',
          runs: 0,
          semanticMetrics: { precision: null, conditionRetention: null, bundleRecall: null, denominator: 0 },
          goldStatus: 'provisional engineering slots; independent review required',
          vectorBaseline: 'not_run_no_embedding_provider',
        },
        null,
        2,
      ),
    );
    console.log('Real model evaluation: not_run (explicit authorization/test key absent).');
  } else {
    const env = isolatedEnvironment('live-evaluation');
    env.ZAICHANG_EVAL_REPORT = out;
    const compiled = path.join(env.ZAICHANG_DATA_DIR, 'live-eval.cjs');
    await build({
      entryPoints: [understandingJudgeReplay ? 'tests/harness/understanding-judge-replay.ts' : understandingLongTail ? 'tests/harness/understanding-long-tail-live.ts' : understandingStories ? 'tests/harness/understanding-live.ts' : understandingProtocol ? 'tests/harness/understanding-protocol-live.ts' : understandingSlice ? 'tests/harness/understanding-slice-live.ts' : understandingControls ? 'tests/harness/understanding-controls-live.ts' : understandingDelegation ? 'tests/harness/understanding-delegation-live.ts' : 'tests/harness/live-eval.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      outfile: compiled,
      loader: { '.md': 'text' },
    });
    fs.writeFileSync(path.join(out, 'environment.json'), JSON.stringify({
      capturedAt: new Date().toISOString(), node: process.version, platform: process.platform,
      modelTransport: lunaTest ? { providerId: 'openai-app-server', model: 'gpt-5.6-luna', temporaryTestSubstitute: true } : { providerId: 'deepseek', model: 'deepseek-flash' },
      command: process.argv.slice(1), compiledSha256: createHash('sha256').update(fs.readFileSync(compiled)).digest('hex'),
      hermesLock: JSON.parse(fs.readFileSync('runtime/hermes/lock.json', 'utf8')),
      sidecarSha256: createHash('sha256').update(fs.readFileSync('runtime/hermes/sidecar.py')).digest('hex'),
    }, null, 2));
    const result = spawnSync(process.execPath, [compiled], { env, stdio: 'inherit', windowsHide: true });
    process.exitCode = result.status ?? 1;
  }
} else {
  const result = spawnSync(
    process.execPath,
    ['scripts/test-harness.mjs', '--suite', 'all', '--report-dir', out],
    { stdio: 'inherit', windowsHide: true },
  );
  process.exitCode = result.status ?? 1;
}

