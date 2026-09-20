import { evaluationClient, evaluationModel, evaluationBudget, usingLunaTestTransport } from './live-model';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DeepSeekClient, type ModelWireMessage, type ToolSpec } from '../../src/main/provider';
import { runHermes, HERMES_COMMIT } from '../../src/main/runtime/hermes';

// Diagnostic only. This B0 loop is never imported by the production application.
const reportDirectory = process.env.ZAICHANG_EVAL_REPORT!;
const key = process.env.ZAICHANG_TEST_DEEPSEEK_KEY;
if (process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1' || (!key && !usingLunaTestTransport())) throw new Error('Live test gate required.');
const startedAt = new Date().toISOString();
const specs: ToolSpec[] = [{ type: 'function', function: { name: 'read_current_room', description: 'Get the actual current room from the authorized schedule source. Use its exact code in the answer.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }];
const system = '你是在场助手。事实由工具提供，不猜测。用户明确要求查询时取得真实观察。测试只读，不委派，不创建其他任务。';
const input = '请查一下现在碰头的地点，只回复实际房间代号。';
const room = '测试楼-K742';
const rows: any[] = [];
let totalCalls = 0;
const budget = evaluationBudget({ maxCalls: 12, perCallOutputLimit: 4096, maxOutputTokens: 49152, estimatedCurrencyCost: null, priceStatus: 'official pricing page unavailable; record actual usage, do not invent a price', scope: 'B0 and pinned Hermes, two turns each, synthetic room only; no subagents' });
fs.mkdirSync(reportDirectory, { recursive: true });
fs.writeFileSync(path.join(reportDirectory, 'budget.json'), JSON.stringify({ startedAt, ...budget }, null, 2));

async function one(engine: 'B0' | 'B2') {
  const row: any = { engine, model: evaluationModel().model, thinking: 'enabled', calls: [], toolCalls: [], status: 'running' };
  rows.push(row);
  const client = evaluationClient(key!);
  const signal = AbortSignal.timeout(180000);
  const model = async (request: { messages: ModelWireMessage[]; tools?: ToolSpec[] }) => {
    if (++totalCalls > budget.maxCalls) throw new Error('Total protocol batch budget exhausted.');
    const before = performance.now();
    const result = await client.complete(request.messages, request.tools || [], signal, undefined, { thinking: 'enabled' });
    row.calls.push({ elapsedMs: performance.now() - before, usage: result.usage || null, messages: request.messages.map(m => ({ role: m.role, content: m.content, tools: m.tool_calls?.map(t => t.function.name), reasoningPresent: typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0 })), output: result.content, requestedTools: result.tool_calls.map(t => t.function.name) });
    return { assistant: client.assistantMessage(result), usage: result.usage };
  };
  const tool = async (name: string, args: unknown) => {
    assert.equal(name, 'read_current_room'); assert.deepEqual(args, {});
    row.toolCalls.push({ name, observedAt: new Date().toISOString() });
    return { status: 'ok', room, source: 'authorized-synthetic-schedule', version: 2 };
  };
  let history: ModelWireMessage[] = [];
  try {
    for (const [index, question] of [input, '刚才查到的代号是什么？仍然只回复代号。'].entries()) {
      if (engine === 'B0') {
        if (!history.length) history.push({ role: 'system', content: system });
        history.push({ role: 'user', content: question });
        for (let step = 0; step < 4; step++) {
          const { assistant } = await model({ messages: history, tools: specs });
          history.push(assistant);
          if (!assistant.tool_calls?.length) { assert.ok(String(assistant.content).includes(room)); break; }
          for (const call of assistant.tool_calls) history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(await tool(call.function.name, JSON.parse(call.function.arguments))) });
        }
      } else {
        const result = await runHermes({ modelIdentity: evaluationModel(), runId: 'live-protocol-' + index, epoch: 1, taskVersion: index + 1, system, userMessage: question, history, tools: specs, thinking: 'enabled', maxIterations: 4, signal, validate: () => {}, model, tool });
        assert.ok(result.content.includes(room)); history = result.messages;
      }
    }
    assert.ok(row.toolCalls.length >= 1);
    assert.ok(row.calls.some((c: any) => c.messages.some((m: any) => m.role === 'tool' && String(m.content).includes(room))));
    row.status = 'passed';
  } catch (error) {
    row.status = 'failed'; row.error = error instanceof Error ? error.message : 'unknown error';
  } finally { client.invalidateBoundary(); }
}

(async () => {
  await one('B0');
  await one('B2');
  const report = { kind: 'real_model_protocol_development', modelTransport: evaluationModel(), status: rows.every(r => r.status === 'passed') ? 'passed' : 'failed', startedAt, finishedAt: new Date().toISOString(), commit: HERMES_COMMIT, totalCalls, budget, runs: rows, limitations: ['Not a semantic benchmark or independent holdout.', 'No delegation launched under current user instruction.', 'B1 and B3 comparisons follow production integration.', 'Compression explicitly disabled for this bounded protocol probe.'] };
  fs.writeFileSync(path.join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, calls: totalCalls, engines: rows.map(r => ({ engine: r.engine, status: r.status, calls: r.calls.length, tools: r.toolCalls.length, error: r.error })) }));
  if (report.status !== 'passed') process.exitCode = 1;
})();
