import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

if (process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1' || (!process.env.ZAICHANG_TEST_DEEPSEEK_KEY && process.env.ZAICHANG_MODEL_TRANSPORT !== 'luna-app-server-test')) throw new Error('Project live evaluation gate required.');
const out = path.resolve(process.env.ZAICHANG_EVAL_REPORT || 'artifacts/understanding-action/ablations');
const runs = [{ name: 'all-enabled', stories: 'A01,A02,A03,A04' }, { name: 'without-prefetch', flag: 'prefetch', stories: 'A01' }, { name: 'without-current-matter', flag: 'currentMatter', stories: 'A02' }, { name: 'without-repair-rejudge', flag: 'repairRejudge', stories: 'A03' }, { name: 'without-closure', flag: 'closure', stories: 'A04' }];
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify({ runs, repeats: 3, scope: 'Synthetic causal probes. Privacy, auth, epoch, receipts and all effect boundaries remain enabled. A03 changes state after read; A04 injects a false completion before any effect. These are not natural-model quality scores.' }, null, 2));
for (const run of runs) {
  const env = { ...process.env, ZAICHANG_STORY_SET: 'ablations', ZAICHANG_STORY_FILTER: run.stories, ZAICHANG_STORY_REPEATS: '3', ZAICHANG_EVAL_REPORT: path.join(out, run.name) };
  if (run.flag) env.ZAICHANG_ENHANCEMENT_ABLATION = run.flag; else delete env.ZAICHANG_ENHANCEMENT_ABLATION;
  const result = spawnSync(process.execPath, ['scripts/evaluate-harness.mjs', '--live', '--understanding-stories'], { env, stdio: 'inherit', windowsHide: true });
  // Disabled-mechanism failures are expected evidence, not suite pass claims.
  fs.writeFileSync(path.join(out, run.name + '-process.json'), JSON.stringify({ exitCode: result.status, expectedQualityFailurePossible: !!run.flag }, null, 2));
  if (fs.existsSync(path.join(out, run.name, 'external-block.json'))) { process.exitCode = 1; break; }
}
