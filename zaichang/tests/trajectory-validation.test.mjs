import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateTrajectories } from '../scripts/validate-trajectories.mjs';

const root = process.cwd();
const specPath = path.join(
  root,
  '在场-Harness-人本协作设计与Codex实施包',
  '在场-Harness-人本协作重构',
  'acceptance',
  'trajectories.json',
);

test('32 development trajectories pass mechanism intake without semantic execution', () => {
  const report = validateTrajectories();
  assert.equal(report.status, 'passed');
  assert.equal(report.mechanism.status, 'passed');
  assert.deepEqual(report.mechanism.cases, { total: 32, passed: 32, failed: 0 });
  assert.equal(report.mechanism.modelInvoked, false);
  assert.equal(report.mechanism.goldForwardedToModel, false);
  assert.equal(report.layers.L.status, 'not_run');
  assert.equal(report.layers.U.status, 'not_run');
  assert.equal(report.consistency.sourceGroups.trajectoryDistinct, 31);
  assert.equal(report.consistency.sourceGroups.documentedDistinct, 40);
  assert.ok(report.consistency.sourceGroups.warning);
  assert.deepEqual(report.consistency.requirements.architectureOnly, ['H13']);
  assert.ok(report.consistency.requirements.warning);

  // Natural-language gold is intentionally not copied into the report.
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('别给我做学习计划'), false);
  assert.equal(serialized.includes('expected_observations'), false);
});

test('the mechanism intake catches malformed observation shape', () => {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const malformed = structuredClone(spec);
  delete malformed.cases[0].steps[0].expected_observations;
  const report = validateTrajectories({ spec: malformed });
  assert.equal(report.status, 'failed');
  assert.ok(report.issues.some((issue) => issue.code === 'missing_step_field'));
  assert.equal(report.layers.L.status, 'not_run');
  assert.equal(report.layers.U.status, 'not_run');
});

test('the existing 94-case acceptance suite remains present', () => {
  const legacyPath = path.join(
    root,
    '在场-Harness-设计与Codex实施包',
    'zaichang-harness-design',
    'acceptance',
    'scenarios.json',
  );
  const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  assert.equal(Array.isArray(legacy.cases), true);
  assert.equal(legacy.cases.length, 94);
});
