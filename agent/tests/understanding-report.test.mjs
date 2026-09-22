import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../scripts/summarize-understanding-evaluation.mjs';

test('report distinguishes unscored runs and does not count repeated expressions as independent stories', () => {
  const rows = [
    { id: 'first', familyId: 'story-a', repeat: 1, status: 'passed', semantic: {} },
    { id: 'paraphrase', familyId: 'story-a', repeat: 2, status: 'passed', semantic: {} },
    { id: 'third', familyId: 'story-a', repeat: 3, status: 'failed', semantic: {} },
    { id: 'blocked', repeat: 1, status: 'failed', error: 'quota' },
  ];
  const result = summarize(rows);
  assert.equal(result.attempted, 4);
  assert.equal(result.fullyAssessed, 3);
  assert.equal(result.assessedPassed, 2);
  assert.equal(result.independentStoryFamilies, 2);
  assert.equal(result.threeRepeatFamilies, 1);
  assert.equal(result.threeRepeatAllPassedFamilies, 0);
  assert.equal(result.unscored.length, 1);
  assert.equal(result.firstResponseMs.p50, null);
  assert.ok(result.descriptiveWilson95[0] < 2 / 3 && result.descriptiveWilson95[1] > 2 / 3);
});

test('an empty report cannot invent a rate, latency or confidence interval', () => {
  const result = summarize([]);
  assert.equal(result.assessedRate, null);
  assert.equal(result.descriptiveWilson95, null);
  assert.equal(result.threeRepeatAllPassedFamilies, 0);
  assert.equal(result.firstResponseMs.p95, null);
});
