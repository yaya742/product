import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const steps = [
  ['scripts/evaluate-harness.mjs'],
  ['scripts/validate-trajectories.mjs'],
  ['scripts/harness-evidence.mjs'],
  ['scripts/evaluate-harness.mjs', '--live'],
  ['scripts/check-project-docs.mjs', '--report'],
];
const results = [];
for (const args of steps) {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  results.push({
    command: [process.execPath, ...args],
    exitCode: r.status,
    status: r.status === 0 ? 'passed' : 'failed',
  });
}
fs.mkdirSync('artifacts/harness/verification', { recursive: true });
fs.writeFileSync(
  'artifacts/harness/verification/gate.json',
  JSON.stringify(
    {
      status: results.every((r) => r.exitCode === 0) ? 'passed' : 'failed',
      results,
      limits:
        'Live not_run is disclosed separately and never counted as semantic success. Desktop/map/package reports are separate required evidence.',
    },
    null,
    2,
  ),
);
if (results.some((r) => r.exitCode !== 0)) process.exitCode = 1;
