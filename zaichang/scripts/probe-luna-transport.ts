import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppServerLunaClient, LUNA_SUBSTITUTE } from '../src/main/luna-provider';
import type { ModelWireMessage, ToolSpec } from '../src/main/provider';
const out = path.resolve(process.env.ZAICHANG_EVAL_REPORT || 'artifacts/understanding-action/luna-transport-live');
fs.mkdirSync(out, { recursive: true });
const calls: any[] = [];
const client = new AppServerLunaClient();
async function ask(messages: ModelWireMessage[], tools: ToolSpec[] = [], forced?: string) {
  const startedAt = new Date().toISOString(), start = performance.now();
  const result = await client.complete(messages, tools, AbortSignal.timeout(120000), undefined, { thinking: 'enabled', phase: 'verification', maxOutputTokens: 4096, ...(forced ? { toolChoice: { type: 'function', function: { name: forced } } } as const : {}) });
  calls.push({ startedAt, phase: 'verification', inputBytes: Buffer.byteLength(JSON.stringify(messages)), modelTransport: LUNA_SUBSTITUTE, usage: result.usage, elapsedMs: performance.now() - start, output: result.content, toolCalls: result.tool_calls });
  return result;
}
let status = 'failed';
try {
  const tool: ToolSpec = { type: 'function', function: { name: 'read_fixture', description: 'Read the synthetic test record.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } } };
  const history: ModelWireMessage[] = [{ role: 'system', content: 'Read the requested tool record, then return the exact code from the tool result. No other text.' }, { role: 'user', content: 'Read test record test-01 and reply with its code.' }];
  const first = await ask(history, [tool], 'read_fixture');
  assert.equal(first.tool_calls.length, 1); assert.equal(first.tool_calls[0].function.name, 'read_fixture'); assert.equal(JSON.parse(first.tool_calls[0].function.arguments).id, 'test-01');
  const nonce = randomUUID();
  history.push(client.assistantMessage(first), { role: 'tool', tool_call_id: first.tool_calls[0].id, content: JSON.stringify({ code: nonce }) });
  const second = await ask(history, [tool]); assert.equal(second.content.trim(), nonce);
  const url = 'data:image/png;base64,' + fs.readFileSync('build/icon.png').toString('base64');
  const visual = await ask([{ role: 'user', content: [{ type: 'text', text: '规则：若图中小圆点位于拱门主体的右半边，只回复“右侧通行”；若在左半边，只回复“左侧通行”。不要描述图片。' }, { type: 'image_url', image_url: { url } }] }]);
  assert.equal(visual.content.trim(), '右侧通行');
  status = 'passed';
} finally {
  client.invalidateBoundary();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ kind: 'real_model_transport_connectivity', status, modelTransport: LUNA_SUBSTITUTE, metadata: client.providerMetadata({ maxOutputTokens: 4096 }), calls, checks: ['Native function calling and actual host result continuation', 'Opaque protocol returned only inside the bounded wire chain', 'Native image plus textual rule in one user message'], limits: ['Temporary Luna substitute; this is not DeepSeek production evidence.', 'App Server rejects max_output_tokens; host checks completed usage. Account cost is unknown.', 'Direct PNG fixture here; JPEG processing and IPC must be verified in Electron separately.'] }, null, 2));
  console.log(JSON.stringify({ status, calls: calls.length, model: LUNA_SUBSTITUTE.model, out }));
}
