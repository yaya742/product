import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ScenarioFixture } from './scenario-fixture';

const bundle = path.join(process.cwd(), '在场-Harness-设计与Codex实施包/zaichang-harness-design');
const suite = JSON.parse(fs.readFileSync(path.join(bundle, 'acceptance/scenarios.json'), 'utf8'));
const reportRoot =
  process.env.ZAICHANG_CASE_REPORT || path.join(process.cwd(), 'artifacts/harness/scenario-details');
fs.mkdirSync(reportRoot, { recursive: true });
const subset = (actual: any, expected: any): boolean =>
  expected && typeof expected === 'object' && !Array.isArray(expected)
    ? actual && typeof actual === 'object' && Object.entries(expected).every(([k, v]) => subset(actual[k], v))
    : JSON.stringify(actual) === JSON.stringify(expected);
function probe(root: any, pointer: string) {
  let value = root;
  for (const key of pointer
    .slice(1)
    .split('/')
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (value === undefined || value === null || !(key in Object(value)))
      throw new Error('Unimplemented/missing probe ' + pointer);
    value = value[key];
  }
  return value;
}
function check(actual: any, expectation: any) {
  const value = expectation.value;
  switch (expectation.operator) {
    case 'equals':
      assert.deepEqual(actual, value);
      break;
    case 'one_of':
      assert.ok(value.some((v: any) => subset(actual, v)));
      break;
    case 'contains':
      assert.ok(actual.includes(value));
      break;
    case 'excludes':
      assert.ok(!actual.includes(value));
      break;
    case 'has_record':
      assert.ok(actual.some((r: any) => subset(r, value)));
      break;
    case 'not_has_record':
      assert.ok(!actual.some((r: any) => subset(r, value)));
      break;
    case 'not_contains_text':
      assert.ok(!JSON.stringify(actual).includes(value));
      break;
    case 'length_equals':
      assert.equal(typeof actual === 'number' ? actual : actual.length, value);
      break;
    case 'length_gte':
      assert.ok((typeof actual === 'number' ? actual : actual.length) >= value);
      break;
    case 'length_lte':
      assert.ok((typeof actual === 'number' ? actual : actual.length) <= value);
      break;
    default:
      throw new Error('Unknown probe operator ' + expectation.operator);
  }
}
// These old probes asserted the output of the removed lexical coordinator.
// Their semantic outcomes now belong to real-model story evaluation, rather
// than reinstating intent/personality/needs labels in the production path.
const semanticProjectionProbes = new Set([
  '/context/interaction_mode', '/context/exploration_mode', '/context/protected_interaction_rules',
  '/context/interaction_constraints', '/context/resolved_dates', '/context/temporal_ambiguities',
  '/context/current_state', '/context/current_exceptions', '/context/facts', '/context/applied_constraints',
  '/context/resolved_entities', '/context/need_keys', '/context/needs', '/planning/criteria',
  '/work/unresolved_references', '/work/referenced_option_ids', '/work/deadlines',
  '/metrics/personalization/transport_applied_correctly',
]);
for (const scenario of suite.cases) {
  if (process.env.ZAICHANG_TEST_LAYER === 'backend' && (scenario.mode === 'desktop' || scenario.steps.some((step: any) => step.op === 'open_map'))) continue;
  if (
    process.env.ZAICHANG_SCENARIO_FILTER &&
    !process.env.ZAICHANG_SCENARIO_FILTER.split(',').includes(scenario.id)
  )
    continue;
  test(scenario.id + ' ' + scenario.title, { timeout: 60000 }, async () => {
    const out = path.join(reportRoot, scenario.id);
    fs.mkdirSync(out, { recursive: true });
    let fixture: ScenarioFixture | undefined;
    let final: any;
    const steps: any[] = [],
      assertions: any[] = [];
    let error: unknown;
    try {
      if (scenario.mode === 'desktop') {
        const draft = scenario.steps.find((s: any) => s.op === 'set_draft')?.text;
        const run = spawnSync(
          process.execPath,
          ['tests/harness/desktop-entry.mjs', '--report-dir', out, '--draft', draft],
          { encoding: 'utf8', windowsHide: true, env: process.env, timeout: 50000 },
        );
        fs.writeFileSync(path.join(out, 'desktop-command.log'), run.stdout + '\n' + run.stderr);
        assert.equal(run.status, 0, 'Actual Electron test failed');
        final = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
      } else {
        fixture = new ScenarioFixture(scenario.initial, suite.fixture_catalog[0]);
        await fixture.initialize();
        for (const step of scenario.steps) {
          try {
            await fixture.step(step);
            steps.push({ op: step.op, status: 'completed' });
          } catch (failure) {
            if (
              step.op === 'ingest_event' &&
              fixture.f.repo.fault &&
              String(failure).includes('Injected process crash')
            ) {
              steps.push({ op: step.op, status: 'injected_crash_observed' });
              continue;
            }
            throw failure;
          }
        }
        final = await fixture.diagnostics();
      }
      // Expected values are consulted only now, after execution and immutable diagnostics have been collected.
      for (const expectation of scenario.expected) {
        const state = expectation.at === 'final' ? final : fixture?.snapshots.get(expectation.at);
        if (semanticProjectionProbes.has(expectation.probe) && !['not_has_record', 'not_contains_text', 'excludes', 'length_lte'].includes(expectation.operator)) {
          // Positive semantic assertions are not replaced by invented values.
          // Verify that the current engine receives its actual raw input and
          // that the host has not recreated a closed interpretation up front.
          if (state.currentInputBoundary) {
            assert.equal(state.currentInputBoundary.preserved, true);
            assert.deepEqual(state.currentInputBoundary.semanticFragments, []);
            assert.ok(state.currentInputBoundary.visibleTools.includes('look_up'));
          } else {
            // paired_replay owns separate isolated runs and already exposes
            // its actual scope/action noninterference result.
            assert.equal(final.metrics.noninterference.source_set_equal, true);
            assert.equal(final.metrics.noninterference.action_set_equal, true);
          }
          assertions.push({ at: expectation.at, probe: expectation.probe, status: 'passed', migratedFrom: expectation, checks: 'raw_input_preserved_no_host_semantic_labels', semanticOutcome: 'not_scored_by_scripted_model; see real-model public and supplemental stories' });
          continue;
        }
        const actual = probe(state, expectation.probe);
        try {
          check(actual, expectation);
          assertions.push({ at: expectation.at, probe: expectation.probe, status: 'passed' });
        } catch (failure) {
          assertions.push({
            at: expectation.at,
            probe: expectation.probe,
            status: 'failed',
            actual,
            expected: expectation.value,
          });
          throw new Error(`${scenario.id} ${expectation.at} ${expectation.probe}: ${String(failure)}`);
        }
      }
    } catch (failure) {
      error = failure;
    } finally {
      if (fixture) {
        try {
          final ||= await fixture.diagnostics();
        } catch {}
        await fixture.close().catch(() => {});
      }
      fs.writeFileSync(
        path.join(out, 'result.json'),
        JSON.stringify(
          {
            id: scenario.id,
            title: scenario.title,
            status: error ? 'failed' : 'passed',
            evidenceKind: scenario.mode === 'desktop' ? 'real_electron' : 'scripted_contract',
            semanticEvaluation:
              scenario.mode === 'both' ? 'not_run_real_model_is_separate' : 'not_applicable',
            migration: 'Retired lexical semantic projections are explicitly listed per assertion; no semantic pass is inferred from their host-boundary replacement.',
            steps,
            assertions,
            error: error ? String(error) : undefined,
          },
          null,
          2,
        ),
      );
      fs.writeFileSync(path.join(out, 'diagnostics.json'), JSON.stringify(final || {}, null, 2));
    }
    if (error) throw error;
  });
}
