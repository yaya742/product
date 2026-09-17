import { evaluationClient, evaluationModel, evaluationBudget, usingLunaTestTransport } from './live-model';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Harness } from '../../src/main/harness';
import { DeepSeekClient, type ModelWireMessage } from '../../src/main/provider';
import { ToolRegistry } from '../../src/main/tools';
import { runHermes } from '../../src/main/runtime/hermes';
import { parseTurnControls } from '../../src/main/runtime/turn-controls';
import { checkLocalDelegation } from '../../src/main/runtime/action-delegation';
import { verifyReadPurpose } from '../../src/main/runtime/read-purpose';
import { understandingCases } from './understanding-cases';
import { setupUnderstanding } from './understanding-fixtures';
import { usageCost } from '../../src/main/runtime/model-usage';
import type { Message } from '../../src/shared/types';

const key = process.env.ZAICHANG_TEST_DEEPSEEK_KEY!;
if ((!key && !usingLunaTestTransport()) || process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1') throw new Error('Live gate required.');
const out = process.env.ZAICHANG_EVAL_REPORT!, group = process.env.ZAICHANG_COMPARISON_GROUP!;
const ids = ['S01', 'S02', 'S03', 'S04', 'S05', 'S19'];
const rows: any[] = []; let calls = 0;
async function main() {
  for (const id of ids) {
    const story = understandingCases.find(story => story.id === id)!, fixture = await setupUnderstanding({ ...story, background: false });
    const { f } = fixture, row: any = { id, group, input: story.turns[0], calls: [], model: evaluationModel().model, thinking: 'enabled', outputLimit: 16384 };
    const factory = (secret: string, model: string) => {
      const client = evaluationClient(secret, model), original = client.complete.bind(client);
      client.complete = async (...args) => {
        if (++calls > 100) throw new Error('Comparison group budget exhausted');
        const options = { ...args[4], thinking: 'enabled' as const, maxOutputTokens: 16384 };
        const call: any = { requestedThinking: args[4]?.thinking, thinking: 'enabled', phase: args[4]?.phase, tools: args[1].map(t => t.function.name), input: args[0].map(m => ({ ...m, reasoning_content: m.reasoning_content === undefined ? undefined : '[protocol_present]' })) };
        row.calls.push(call); const start = performance.now();
        try { const result = await original(args[0], args[1], args[2], args[3], options); Object.assign(call, { elapsedMs: performance.now() - start, output: result.content, toolCalls: result.tool_calls, usage: result.usage, cost: usageCost(result.usage) }); return result; }
        catch (error) { call.error = error instanceof Error ? error.message : 'unknown'; throw error; }
      };
      return client;
    };
    let harness: Harness | undefined;
    const started = performance.now();
    try {
      const controls = story.attachment ? { attachment: { id: id + '-material', name: 'synthetic.txt', text: story.attachment } } : {};
      if (['B1', 'B3'].includes(group)) {
        let message: Message | undefined;
        harness = new Harness(f.store, () => key, event => { if (event.type === 'message' && event.message.role === 'assistant') message = structuredClone(event.message); }, factory);
        harness.start(fixture.sessionId, row.input, controls); await harness.idle(); row.output = message?.content; row.messageStatus = message?.status;
      } else {
        const client = factory(key, 'deepseek-flash'), controller = new AbortController(), runtime = f.store.runtime;
        const semantic = await parseTurnControls(row.input, client, controller.signal, { sources: [...f.policy.validate(f.scope()).sources], capabilities: runtime.broker.catalog(f.scope(), '', 0, 100).items });
        const run = runtime.begin(row.input, id + '-current', fixture.sessionId, controller.signal, { ...controls, semantic });
        const pack = await runtime.compile(run, true);
        const registry = new ToolRegistry({ store: f.store, runtimeSession: run, userText: row.input, currentUserId: run.events[0].id, signal: controller.signal, child: false, step() {}, plan() {}, action() {}, changed() {}, delegate: async () => ({ status: 'unsupported', reason: 'No delegation required by these paired tasks.' }), verifyReadPurpose: request => verifyReadPurpose(row.input, request, client.complete.bind(client), controller.signal), verifyLocalDelegation: action => checkLocalDelegation({ current: { id: run.events[0].id, text: row.input }, history: [], now: run.ingress.contract.now, timeZone: run.ingress.contract.timeZone, action }, client.complete.bind(client), controller.signal) });
        const tools = registry.specs(), system = '理解用户当前需要，使用授权资料和工具。该查询时查询，明确本地委托按工具回执办理；只倾诉不做计划，来源与未知保持真实。回答当前问题即可。';
        const context: ModelWireMessage[] = [{ role: 'user', content: runtime.context.serialize(pack) }];
        const user = runtime.generationInput(run);
        if (group === 'B2') {
          const result = await runHermes({ runId: run.ingress.contract.id, epoch: f.repo.epoch, taskVersion: 1, system, userMessage: user, history: context, tools, thinking: 'enabled', maxIterations: 12, maxOutputTokens: 16384, signal: controller.signal, validate: () => { f.policy.validate(run.ingress.contract.scope); }, model: async request => { const response = await client.complete(request.messages, request.tools || [], controller.signal, undefined, { thinking: 'enabled', maxOutputTokens: 16384, phase: 'main' }); return { assistant: client.assistantMessage(response), usage: response.usage }; }, tool: async (name, args) => JSON.parse(await registry.execute(name, JSON.stringify(args))) });
          row.output = result.content;
        } else {
          // Diagnostic baseline only. Never imported into the product.
          const messages: ModelWireMessage[] = [{ role: 'system', content: system }, ...context, { role: 'user', content: user }];
          for (let iteration = 0; iteration < 12; iteration++) {
            const response = await client.complete(messages, tools, controller.signal, undefined, { thinking: 'enabled', maxOutputTokens: 16384, phase: 'main' });
            messages.push(client.assistantMessage(response));
            if (!response.tool_calls.length) { row.output = response.content; break; }
            for (const call of response.tool_calls) messages.push({ role: 'tool', tool_call_id: call.id, content: await registry.execute(call.function.name, call.function.arguments) });
          }
        }
        row.messageStatus = row.output ? 'done' : 'error'; runtime.finish(run);
      }
      row.environment = { agenda: f.store.agenda(), actions: f.store.runtime.actions.list(f.scope()), reads: f.repo.access };
      assert.equal(row.messageStatus, 'done');
      if (id === 'S01') assert.ok(row.output.includes('B214'));
      else if (['S04', 'S19'].includes(id)) { assert.equal(row.environment.agenda.length, 1); assert.equal(row.environment.agenda[0].durationMinutes, undefined); assert.equal(Date.parse(row.environment.agenda[0].startsAt), Date.parse(`2026-09-15T${id === 'S04' ? '15' : '09'}:00:00+08:00`)); }
      else assert.equal(row.environment.agenda.length, 0);
      row.status = 'passed_environment_checks';
    } catch (error) { row.status = 'failed'; row.error = error instanceof Error ? error.message : 'unknown'; }
    finally {
      await harness?.stop(); await fixture.close(); row.elapsedMs = performance.now() - started;
      rows.push(row); fs.writeFileSync(path.join(out, group + '.json'), JSON.stringify({ kind: 'real_model_paired_development', modelTransport: evaluationModel(), group, rows, calls, limit: 'Six paired stories, environment checks plus preserved outputs; no independent human score. B1 uses frozen legacy source with explicit thinking/output-limit normalization.' }, null, 2));
      console.log(JSON.stringify({ group, id, status: row.status, error: row.error, calls: row.calls.length }));
    }
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Comparison failed'); process.exitCode = 1; });
