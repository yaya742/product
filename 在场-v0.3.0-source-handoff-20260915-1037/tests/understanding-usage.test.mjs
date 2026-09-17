import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCalls, summarizeUsage } from '../scripts/summarize-understanding-usage.mjs';

test('Luna account usage is counted but never priced as DeepSeek or represented as zero cost', () => {
  const result = summarizeUsage([{ file: 'luna/S01-r1.json', report: { calls: [{ input: [], elapsedMs: 1, usage: { prompt_tokens: 90, completion_tokens: 20, providerId: 'openai-app-server', model: 'gpt-5.6-luna' } }] } }]);
  assert.equal(result.usageAvailable, 1); assert.equal(result.usageMissing, 0); assert.equal(result.costAvailable, 0); assert.equal(result.costUnknown, 1);
  assert.equal(result.providers['openai-app-server'].inputTokens, 90); assert.equal(result.phases.unclassified_legacy.outputTokens, 20);
});

test('usage inventory deduplicates repeated captures but never treats a model-supplied fake call as billing evidence', () => {
  const call = { startedAt: '2026-09-13T10:00:00Z', phase: 'main', thinking: 'enabled', input: [{ role: 'user', content: 'private text' }], output: 'answer', usage: { prompt_tokens: 100, completion_tokens: 50 } };
  const report = { kind: 'real_model_development', calls: [call], environment: { calls: [{ ...call, usage: { prompt_tokens: 9999999, completion_tokens: 9999999 } }] } };
  const result = summarizeUsage([{ file: 'original.json', report }, { file: 'copy.json', report }]);
  assert.equal(result.attemptsCaptured, 1); assert.equal(result.duplicateRecords, 1); assert.equal(result.phases.main.inputTokens, 100);
  assert.ok(!JSON.stringify(result).includes('private text'));
});

test('legacy aggregate count gaps and missing usage remain explicit', () => {
  const report = { kind: 'real_model_control_development', calls: 4, rows: [{ usage: { prompt_tokens: 20, completion_tokens: 10 } }, { status: 'failed' }] };
  assert.equal(extractCalls(report, 'controls.json').uncaptured, 3);
  const result = summarizeUsage([{ file: 'controls.json', report }]);
  assert.equal(result.usageMissing, 0); assert.equal(result.uncapturedReportedCalls, 3);
  assert.equal(result.legacyRecordsWithoutGlobalCallIdentity, 1);
});

test('incremental case summaries do not count the same reported calls as uncaptured again', () => {
  const call = { phase: 'main', input: [], elapsedMs: 1, usage: { prompt_tokens: 20, completion_tokens: 10 } };
  const result = summarizeUsage([{ file: 'batch/S01-r1.json', report: { kind: 'real_model_development', calls: [call] } }, { file: 'batch/report.json', report: { kind: 'real_model_public_development', totalCalls: 1, results: [{ id: 'S01', repeat: 1 }] } }]);
  assert.equal(result.attemptsCaptured, 1); assert.equal(result.uncapturedReportedCalls, 0);
});
