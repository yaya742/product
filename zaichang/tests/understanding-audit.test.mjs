import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRun } from '../scripts/audit-understanding-run.mjs';

const passed = (id, repeat) => ({ id, repeat, status: 'passed', turns: [{ input: '测试输入', output: '测试输出', access: [], agenda: [] }], calls: [{ phase: 'main' }], environment: { before: {}, agenda: [], actions: [], receipts: [], work: [], memory: [], messages: [], jobs: [] }, mechanismErrors: [], semantic: { passed: true, truthful: true, needsMet: true, autonomyRespected: true, correctionRespected: true } });
test('the audit rejects missing, duplicate and unscored repeats instead of selecting best attempts', () => {
  const stories = [{ id: 'S04' }, { id: 'N05' }];
  const rows = [passed('S04', 1), passed('S04', 1), passed('S04', 2), { id: 'S04', repeat: 3, status: 'failed', error: 'quota' }];
  const audit = auditRun(stories, rows);
  assert.equal(audit.expectedRuns, 6); assert.equal(audit.presentRuns, 3);
  assert.deepEqual(audit.duplicates, ['S04:1']); assert.equal(audit.missing.length, 3); assert.equal(audit.unscored.length, 1);
  assert.equal(audit.backendModelThresholdsMet, false); assert.equal(audit.productComplete, false);
});
test('a truthfulness violation cannot disappear inside a high average success rate', () => {
  const stories = [{ id: 'S04' }], rows = [passed('S04', 1), passed('S04', 2), passed('S04', 3)];
  rows[2].semantic.truthful = false;
  const audit = auditRun(stories, rows);
  assert.equal(audit.criticalCandidates.length, 1); assert.equal(audit.passedRuns, 2); assert.equal(audit.stability.allRepeatedPassStories, 0);
  assert.equal(audit.backendModelThresholdsMet, false);
});
test('empty data and evidence from unrelated stories never establish completeness', () => {
  const empty = auditRun([], []); assert.equal(empty.backendModelThresholdsMet, false); assert.equal(empty.productComplete, false);
  const audit = auditRun([{ id: 'S04' }], [passed('OTHER', 1)]);
  assert.equal(audit.unexpected.length, 1); assert.equal(audit.missing.length, 3); assert.equal(audit.complete, false);
  const fakePass = auditRun([{ id: 'S04', turns: ['expected turn'] }], [1,2,3].map(repeat => ({ ...passed('S04', repeat), environment: {} })));
  assert.equal(fakePass.unscored.length, 3); assert.equal(fakePass.passedRuns, 0); assert.equal(fakePass.complete, false);
});
