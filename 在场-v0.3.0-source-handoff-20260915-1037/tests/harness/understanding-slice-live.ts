import { evaluationClient, evaluationModel, evaluationBudget, usingLunaTestTransport } from './live-model';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Fixture } from './support';
import { Harness } from '../../src/main/harness';
import { DeepSeekClient } from '../../src/main/provider';
import type { Message } from '../../src/shared/types';
import { DEEPSEEK_PRICING, usageCost } from '../../src/main/runtime/model-usage';

const key = process.env.ZAICHANG_TEST_DEEPSEEK_KEY;
if ((!key && !usingLunaTestTransport()) || process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1') throw new Error('Live test gate required.');
const out = process.env.ZAICHANG_EVAL_REPORT!;
const budget = evaluationBudget({ maxCalls: 30, perCallOutputTokens: 8192, maxOutputTokens: 245760, estimatedCurrencyCostUpperUsd: 30 * (24000 * 0.3 + 8192 * 1.2) / 1000000, pricing: usingLunaTestTransport() ? null : DEEPSEEK_PRICING, backgroundExtraction: 'paused for foreground isolation', subagents: 'not_launched' });
fs.writeFileSync(path.join(out, 'budget.json'), JSON.stringify(budget, null, 2));
const f = new Fixture();
f.store.saveSettings({ mode: 'deepseek', memoryEnabled: true, weatherEnabled: false });
f.memory.paused = true;
const requests: any[] = [], turns: any[] = [];
let latest: Message | undefined, count = 0;
const harness = new Harness(f.store, () => key!, event => {
  if (event.type === 'message' && event.message.role === 'assistant') latest = event.message;
}, (secret, model) => {
  const client = evaluationClient(secret, model, (async (url, init) => {
    const response = await fetch(url, init);
    if (!response.ok) {
      requests.at(-1).httpFailure = { status: response.status };
    }
    return response;
  }) as typeof fetch), original = client.complete.bind(client);
  client.complete = async (...args) => {
    if (++count > budget.maxCalls) throw new Error('Fixed batch budget exhausted');
    const at = performance.now();
    const item: any = { call: count, thinking: args[4]?.thinking, toolNames: args[1].map(t => t.function.name), input: args[0].map(m => ({ ...m, reasoning_content: m.reasoning_content === undefined ? undefined : '[protocol_present]' })) };
    requests.push(item);
    try {
      const result = await original(...args);
      Object.assign(item, { elapsedMs: performance.now() - at, usage: result.usage || null, cost: usageCost(result.usage), output: result.content, calls: result.tool_calls });
      return result;
    } catch (error) { item.error = error instanceof Error ? error.message : 'error'; throw error; }
  };
  return client;
});
async function turn(id: string, text: string, check: () => void, sessionId?: string, controls = {}) {
  const row: any = { id, input: text, callsBefore: count, accessesBefore: f.repo.access.length, agendaBefore: f.store.agenda().length };
  turns.push(row);
  const session = harness.start(sessionId, text, controls).sessionId;
  await harness.idle();
  row.output = latest?.content; row.messageStatus = latest?.status;
  row.calls = count - row.callsBefore;
  row.access = f.repo.access.slice(row.accessesBefore);
  row.agenda = f.store.agenda();
  row.actions = f.store.runtime.actions.list(f.scope());
  try { assert.equal(latest?.status, 'done'); check(); row.status = 'passed'; }
  catch (error) { row.status = 'failed'; row.error = error instanceof Error ? error.message : 'error'; }
  fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify({ turns, requests }, null, 2));
  console.log(JSON.stringify({ id, status: row.status, calls: row.calls, error: row.error }));
  if (requests.at(-1)?.httpFailure) throw new Error('Stop batch at first provider protocol failure.');
  return session;
}
(async () => {
  try {
    await turn('slice-mixed', '今天真烦。明天下午三点有组会，帮我记到本地安排里，结束时间没定；其他事情先别安排。', () => {
      const agenda = f.store.agenda();
      assert.equal(agenda.length, 1); assert.equal(Date.parse(agenda[0].startsAt!), Date.parse('2026-09-15T15:00:00+08:00'));
      assert.equal(agenda[0].durationMinutes, undefined);
      assert.ok(f.store.runtime.actions.list(f.scope()).some(a => a.status === 'succeeded' && f.store.runtime.actions.receipts(f.scope(), a.id).some(r => r.status === 'confirmed_success')));
    });
    await turn('slice-read', '我的本地安排里刚放进去的组会是几点？替我核实一下。', () => {
      assert.ok(requests.slice(-5).some(r => r.calls?.some((c: any) => c.function.name === 'look_up')));
      assert.ok(latest?.content.includes('15:00') || latest?.content.includes('三点') || latest?.content.includes('3点'));
      assert.equal(f.store.agenda().length, 1);
    });
    await turn('slice-counterexample', '帮我分析一下，为什么我每次开会都很紧张。', () => assert.equal(f.store.agenda().length, turns.at(-1).agendaBefore));
    const correctionSession = await turn('slice-context', '我已经把电脑带到学校了。先不用建议，我只是告诉你这个现状。', () => assert.equal(f.store.agenda().length, turns.at(-1).agendaBefore));
    await turn('slice-correction', '刚才说错了，电脑其实仍放在住处。现在只说电脑在哪里。', () => assert.ok(latest?.content.includes('住处')), correctionSession);
    await turn('slice-attachment', '这次只根据附件回答编号，不读以前的对话和个人资料。', () => {
      const row = turns.at(-1)!;
      assert.ok(latest?.content.includes('ATT-637'));
      assert.ok(row.access.every((a: any) => a.source === 'current'));
    }, undefined, { attachment: { id: 'slice-attachment-637', name: 'synthetic.txt', text: '编号是 ATT-637。' } });
  } finally {
    await harness.stop();
    const report = { kind: 'real_model_original_harness_entry_development', modelTransport: evaluationModel(), status: turns.every(t => t.status === 'passed') ? 'passed' : 'failed', budget, calls: count, turns, requests, limits: ['Electron UI not yet tested.', 'This is a six-turn development slice, not the 40-story benchmark.', 'Background memory paused in this batch.', 'Independent human evaluation not run.'] };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    f.close();
    if (report.status !== 'passed') process.exitCode = 1;
  }
})().catch(error => { console.error(error instanceof Error ? error.message : 'Live batch failed.'); process.exitCode = 1; });
