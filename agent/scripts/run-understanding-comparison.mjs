import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { isolatedEnvironment } from './test-environment.mjs';

const lunaTest = process.env.ZAICHANG_MODEL_TRANSPORT === 'luna-app-server-test';
const modelTransport = lunaTest ? { model: 'gpt-5.6-luna', providerId: 'openai-app-server', temporaryTestSubstitute: true } : { model: 'deepseek-flash', providerId: 'deepseek' };
if (process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1' || (!lunaTest && !process.env.ZAICHANG_TEST_DEEPSEEK_KEY)) throw new Error('Use the project live evaluation wrapper.');
const root = process.cwd(), out = path.resolve(process.env.ZAICHANG_EVAL_REPORT || 'artifacts/understanding-action/comparison');
fs.mkdirSync(out, { recursive: true });
const baseline = JSON.parse(fs.readFileSync('artifacts/understanding-action/baseline/manifest.json', 'utf8'));
const groups = (process.env.ZAICHANG_COMPARISON_GROUPS || 'B0,B1,B2,B3').split(',');
fs.writeFileSync(path.join(out, 'budget.json'), JSON.stringify({ groups, modelTransport, storiesPerGroup: 6, maxCallsPerGroup: 100, outputLimit: 16384, thinking: 'enabled', estimatedUpperUsd: lunaTest ? null : groups.length * 100 * (120000 * .3 + 16384 * 1.2) / 1e6, privateData: 'synthetic only', legacySnapshot: baseline.snapshot }, null, 2));
for (const group of groups) {
  if (!['B0','B1','B2','B3'].includes(group)) throw new Error('Unknown comparison group');
  const env = isolatedEnvironment('comparison-' + group), compiled = path.join(env.ZAICHANG_DATA_DIR, 'comparison.cjs');
  env.ZAICHANG_EVAL_REPORT = out; env.ZAICHANG_COMPARISON_GROUP = group;
  const legacyFiles = new Map(baseline.files.map(file => [file.path, file.sha256]));
  const plugin = { name: 'frozen-legacy-source', setup(builder) { builder.onResolve({ filter: /^\./ }, args => {
    const resolved = path.resolve(args.resolveDir, args.path), relative = path.relative(root, resolved).replaceAll('\\','/');
    if (!relative.startsWith('src/')) return;
    // Keep comparison instrumentation and newly introduced modules current;
    // all modules that existed in the frozen product use that actual source.
    const file = [relative, relative + '.ts', relative + '/index.ts'].find(file => legacyFiles.has(file));
    if (!file) return;
    const target = path.join(baseline.snapshot, file), digest = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    if (digest !== legacyFiles.get(file)) throw new Error('Legacy snapshot mutated: ' + file);
    return { path: target };
  }); } };
  await build({ entryPoints: ['tests/harness/understanding-comparison-live.ts'], outfile: compiled, bundle: true, platform: 'node', format: 'cjs', target: 'node24', loader: { '.md': 'text' }, plugins: group === 'B1' ? [plugin] : [] });
  fs.writeFileSync(path.join(out, group + '-environment.json'), JSON.stringify({ at: new Date().toISOString(), compiledSha256: createHash('sha256').update(fs.readFileSync(compiled)).digest('hex'), legacySnapshot: group === 'B1' ? baseline.snapshot : null, sidecarSha256: createHash('sha256').update(fs.readFileSync('runtime/hermes/sidecar.py')).digest('hex') }, null, 2));
  const result = spawnSync(process.execPath, [compiled], { env, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exitCode = 1;
}
