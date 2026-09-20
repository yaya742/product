import { evaluationClient, evaluationModel, evaluationBudget, usingLunaTestTransport } from './live-model';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Fixture } from './support';
import { Harness } from '../../src/main/harness';
import { DeepSeekClient } from '../../src/main/provider';
import type { Message } from '../../src/shared/types';
import { usageCost, DEEPSEEK_PRICING } from '../../src/main/runtime/model-usage';

const key = process.env.ZAICHANG_TEST_DEEPSEEK_KEY;
if ((!key && !usingLunaTestTransport()) || process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1') throw new Error('Live gate required.');
const out = process.env.ZAICHANG_EVAL_REPORT!;
const f = new Fixture();
f.store.saveSettings({ mode: 'deepseek', memoryEnabled: false, weatherEnabled: false });
f.ingest('PRIVATE_PARENT_PROFILE_CANARY');
const accesses: string[] = [], requests: any[] = [];
const values = { left: 743, right: 1189 };
f.store.runtime.broker.register({
  manifest: { id: 'synthetic-packets', version: '1', sourceId: 'synthetic:packets', trust: 'bundled_reviewed', egressHosts: [], platforms: ['*'], simulated: true, offline: 'unsupported', license: 'test fixture', capabilities: [{
    name: 'sample.packet', displayName: '测试资料片段', description: '读取两个相互独立的测试资料片段；packet可为left或right，返回该片段真实数值。', version: '1', input: z.object({ packet: z.enum(['left', 'right']) }).strict(), output: z.object({ packet: z.string(), value: z.number() }).strict(), effect: 'read', requiredScopes: ['evidence:read'], subjects: ['self'], worlds: ['real'], timeoutMs: 1000, maxBytes: 4000, supportsIdempotency: false, supportsInspect: false, supportsCancel: false,
  }] },
  invoke: (_name, args) => { accesses.push(args.packet); return { status: 'fresh', sourceId: 'synthetic:packets', data: { packet: args.packet, value: values[args.packet as keyof typeof values] }, observedAt: f.clock.now(), fetchedAt: f.clock.now(), simulated: true }; },
}, { reviewed: true, source: 'synthetic isolated evaluation' });
let message: Message | undefined, calls = 0;
const budget = evaluationBudget({ maxCalls: 16, maxOutputPerCall: 8192, estimatedMaxUsd: 16 * (24000 * 0.3 + 8192 * 1.2) / 1e6, pricing: usingLunaTestTransport() ? null : DEEPSEEK_PRICING });
fs.writeFileSync(path.join(out, 'budget.json'), JSON.stringify(budget, null, 2));
const harness = new Harness(f.store, () => key!, event => { if (event.type === 'message' && event.message.role === 'assistant') message = event.message; }, (secret, model) => {
  const client = evaluationClient(secret, model), complete = client.complete.bind(client);
  client.complete = async (...args) => {
    if (++calls > budget.maxCalls) throw new Error('Delegation batch budget exhausted.');
    const row: any = { call: calls, startedAt: new Date().toISOString(), tools: args[1].map(t => t.function.name), messages: args[0].map(m => ({ ...m, reasoning_content: m.reasoning_content ? '[protocol_present]' : undefined })) }; requests.push(row);
    const response = await complete(...args);
    Object.assign(row, { finishedAt: new Date().toISOString(), output: response.content, calls: response.tool_calls, usage: response.usage || null, cost: usageCost(response.usage) });
    return response;
  };
  return client;
});
(async () => {
  let status = 'failed', error: string | undefined;
  try {
    harness.start(undefined, '请启动两个独立只读子任务，分别调用资料能力 sample.packet 读取 packet=left 和 packet=right。你收到两份真实数值后相加，只给出结果，不读取个人历史。');
    await harness.idle();
    assert.equal(message?.status, 'done');
    assert.ok(message.content.includes(String(values.left + values.right)));
    const children = message.contextReceipt?.delegations || [];
    assert.equal(children.length, 2);
    assert.ok(children.every(child => child.status === 'consumed' && child.responses >= 2 && child.toolCalls >= 1));
    assert.ok(accesses.includes('left') && accesses.includes('right'));
    assert.ok(!JSON.stringify(requests).includes('PRIVATE_PARENT_PROFILE_CANARY'));
    status = 'passed';
  } catch (e) { error = e instanceof Error ? e.message : 'error'; }
  finally {
    await harness.stop();
    const report = { kind: 'real_model_native_Hermes_delegation', modelTransport: evaluationModel(), status, error, calls, budget, accesses, message, requests, limitation: 'Isolated two-source development probe, not independent human evaluation or general task quality.' };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status, error, calls, children: message?.contextReceipt?.delegations }));
    f.close();
    if (status !== 'passed') process.exitCode = 1;
  }
})();
