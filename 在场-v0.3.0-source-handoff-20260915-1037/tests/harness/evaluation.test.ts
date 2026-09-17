import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-expect-error plain JS evaluation utility
import { scoreRuns, wilson } from '../../scripts/score-harness-evaluation.mjs';
test('semantic corpus is disjoint by situation and uses only declared question groups', () => {
  const corpus = JSON.parse(fs.readFileSync('tests/harness/semantic-corpus.json', 'utf8')),
    trace = JSON.parse(
      fs.readFileSync(
        '在场-Harness-设计与Codex实施包/zaichang-harness-design/acceptance/traceability.json',
        'utf8',
      ),
    );
  const groups = new Set(trace.groups.map((g: any) => g.group_id));
  assert.equal(new Set(corpus.episodes.map((e: any) => e.id)).size, corpus.episodes.length);
  assert.ok(corpus.episodes.filter((e: any) => e.split === 'heldout').length >= 8);
  for (const e of corpus.episodes) {
    assert.ok(e.turns.length >= 2);
    assert.ok(e.groups.every((g: string) => groups.has(g)));
  }
});
test('evaluation scorer rejects missing adjudications, reports denominators and never averages away unsafe events', () => {
  const runs = [
      { episodeId: 'synthetic-a', variant: 'full', split: 'heldout' },
      { episodeId: 'synthetic-b', variant: 'full', split: 'heldout' },
    ],
    labels = runs.map((r) => ({
      ...r,
      predictedAssertions: 10,
      supportedAssertions: 10,
      conditionSlots: 10,
      preservedConditionSlots: 10,
      requiredBundles: 10,
      recalledBundles: 10,
      unsafeEvents: 0,
      hardViolations: 0,
    }));
  assert.throws(() => scoreRuns(runs, labels.slice(0, 1)), /Every run/);
  let result = scoreRuns(runs, labels)[0];
  assert.equal(result.status, 'passed');
  assert.equal(result.metrics[0].denominator, 20);
  assert.ok(result.metrics[0].wilson95[0] < 1);
  assert.equal(wilson(0, 0), null);
  labels[0].unsafeEvents = 1;
  result = scoreRuns(runs, labels)[0];
  assert.equal(result.status, 'failed');
});
