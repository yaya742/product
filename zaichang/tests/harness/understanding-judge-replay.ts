import { verifiedTimeConversions } from './evaluation-time';
import { EVALUATION_RESPONSE_FORM_RULE } from './understanding-scoring';
import { evaluationClient, evaluationModel, evaluationBudget, usingLunaTestTransport } from './live-model';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DeepSeekClient, ProviderError } from '../../src/main/provider';
import { structuredResult } from '../../src/main/runtime/structured-result';
import { DEEPSEEK_PRICING, usageCost } from '../../src/main/runtime/model-usage';

const key = process.env.ZAICHANG_TEST_DEEPSEEK_KEY;
if ((!key && !usingLunaTestTransport()) || process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1') throw new Error('Authorized live evaluation entry required.');
const root = path.resolve('artifacts/understanding-action');
const source = path.resolve(process.env.ZAICHANG_JUDGE_REPLAY_FILE || path.join(root, 'sixty-stories-three-repeat/N18-r3.json'));
if (!source.startsWith(root + path.sep)) throw new Error('Replay must use an isolated development artifact.');
const bytes = fs.readFileSync(source), record = JSON.parse(bytes.toString('utf8'));
if (record.kind !== 'real_model_development') throw new Error('Replay requires an original development trajectory.');
const prior = record.calls?.findLast((call: any) => call.phase === 'evaluation_judge');
if (!Array.isArray(prior?.input)) throw new Error('No original judge input was captured.');
const replayInput = [{ role: 'system', content: EVALUATION_RESPONSE_FORM_RULE }, ...prior.input.map((message: any) => {
  if (message.role !== 'user') return message;
  const value = JSON.parse(message.content);
  return { ...message, content: JSON.stringify({ ...value, timeConversions: verifiedTimeConversions({ environment: value.environment, hostContexts: value.hostContexts, hostObservations: value.hostObservations, observations: value.observations }, 'Asia/Shanghai') }) };
})];
const schema = z.object({ passed: z.boolean(), needsMet: z.boolean(), truthful: z.boolean(), correctionRespected: z.boolean(), autonomyRespected: z.boolean(), issues: z.array(z.string()), rationale: z.string() }).strict();
const { $schema: _, ...parameters } = z.toJSONSchema(schema);
const client = evaluationClient(key), calls: any[] = [];
let reservedUsd = 0;
const report: any = { kind: 'recorded_trajectory_judge_replay', modelTransport: evaluationModel(), startedAt: new Date().toISOString(), originalFile: path.relative(root, source), originalSha256: createHash('sha256').update(bytes).digest('hex'), originalStatus: record.status, evaluatorChange: 'Added deterministic timezone conversions; original evidence and response unchanged.', id: record.id, repeat: record.repeat, budget: { maxCalls: 2, maxCostUsd: usingLunaTestTransport() ? null : .5, maxOutputTokens: 16384, maxInputBytes: 480000 }, calls,
  limitations: ['Reassesses the original captured evidence, without executing the product again.', 'Does not replace or rewrite the original missing/failed assessment.', 'This is model review, not independent human review.'] };
async function replay() {
try {
  report.semantic = await structuredResult({ schema, tool: { type: 'function', function: { name: 'evaluate_story', description: '根据原始环境和轨迹评估任务实际结果。', parameters } }, messages: replayInput, signal: AbortSignal.timeout(210000), options: { thinking: 'enabled', maxOutputTokens: 16384, phase: 'evaluation_judge' }, failureCode: 'replay_incomplete', failureMessage: 'Recorded trajectory remains unscored.', complete: async (...args) => {
    const inputBytes = Buffer.byteLength(JSON.stringify([args[0], args[1]]));
    const reserve = usingLunaTestTransport() ? 0 : (inputBytes * DEEPSEEK_PRICING.perMillion.peak.cacheMiss + 16384 * DEEPSEEK_PRICING.perMillion.peak.output) / 1e6;
    if (inputBytes > 480000 || calls.length >= 2 || reservedUsd + reserve > .5) throw new Error('Replay budget reached.');
    reservedUsd += reserve;
    const call: any = { phase: 'evaluation_judge', thinking: args[4]?.thinking, model: client.model, inputBytes, reserveUsd: usingLunaTestTransport() ? null : reserve, startedAt: new Date().toISOString() };
    calls.push(call);
    try {
      const result = await client.complete(...args);
      Object.assign(call, { usage: result.usage, cost: usageCost(result.usage), output: result.content, toolCalls: result.tool_calls });
      return result;
    } catch (error) {
      Object.assign(call, { error: error instanceof Error ? error.message : 'unknown', code: error instanceof ProviderError ? error.code : 'unknown', usage: error instanceof ProviderError ? error.usage : undefined });
      throw error;
    }
  } });
  report.status = report.semantic.passed ? 'passed_reassessment' : 'failed_reassessment';
} catch (error) { report.status = 'unscored'; report.error = error instanceof Error ? error.message : 'unknown'; }
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(process.env.ZAICHANG_EVAL_REPORT!, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, id: record.id, repeat: record.repeat, calls: calls.length, semantic: report.semantic }));
if (report.status !== 'passed_reassessment') process.exitCode = 1;
}
void replay().catch(error => { console.error(error instanceof Error ? error.message : 'Replay failed'); process.exitCode = 1; });
