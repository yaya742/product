import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { AppServerLunaClient, LUNA_ENDPOINT, LUNA_MODEL, lunaInput, lunaRequest } from '../src/main/luna-provider';
import { usageCost } from '../src/main/runtime/model-usage';
import { createModelClient } from '../src/main/model-selection';
import type { ModelWireMessage, ToolSpec } from '../src/main/provider';
const tool: ToolSpec = { type: 'function', function: { name: 'lookup', description: 'Read exact source.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } } };
const peer = path.resolve('tests/fixtures/luna-app-server.mjs');
const childSpawn: typeof spawn = ((_: string, _args: unknown, options: any) => {
  assert.equal(options.env.DEEPSEEK_API_KEY, undefined); assert.equal(options.env.ZAICHANG_TEST_DEEPSEEK_KEY, undefined);
  assert.equal(options.env.CODEX_THREAD_ID, undefined); assert.equal(options.windowsHide, true);
  return spawn(process.execPath, [peer], options);
}) as typeof spawn;
function stream(output: any[], tokens = 20, model = LUNA_MODEL, status = 'completed') {
  return new Response(output.map(item => ({ type: 'response.output_item.done', item })).concat([{ type: `response.${status}`, response: { model, output, usage: { input_tokens: 30, output_tokens: tokens, total_tokens: 30 + tokens } } }] as any).map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const answer = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
test('projection retains roles, full original, ordered image bytes and function result IDs without mutation', () => {
  const messages: ModelWireMessage[] = [{ role: 'system', content: 'system rules' }, { role: 'user', content: [{ type: 'text', text: '完整原话\n末尾约束' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } }] }, { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"id":"a"}' } }] }, { role: 'tool', tool_call_id: 't1', content: '{"source":"exact"}' }];
  const original = structuredClone(messages); const request = lunaRequest(messages, [tool], { toolChoice: { type: 'function', function: { name: 'lookup' } }, thinking: 'enabled' });
  assert.deepEqual(messages, original); assert.equal(request.input[0].role, 'developer'); assert.equal(request.input[1].content[0].text, '完整原话\n末尾约束');
  assert.equal(request.input[1].content[1].image_url, 'data:image/jpeg;base64,AA=='); assert.equal(request.input[3].call_id, 't1');
  assert.deepEqual(request.tools[0].parameters, tool.function.parameters); assert.deepEqual(request.tool_choice, { type: 'function', name: 'lookup' });
  assert.equal(request.reasoning.effort, 'xhigh'); assert.equal(request.store, false);
});
test('single completion replaces automatic Codex input/tools and returns native calls to the existing host', async () => {
  const requests: any[] = [];
  const client = new AppServerLunaClient({ executable: process.execPath, spawn: childSpawn, fetcher: async (url, init) => {
    assert.equal(url, LUNA_ENDPOINT); assert.equal(init!.redirect, 'error'); assert.equal((init!.headers as any).authorization, 'Bearer synthetic-auth');
    requests.push(JSON.parse(String(init!.body)));
    return stream([{ type: 'reasoning', encrypted_content: 'synthetic-opaque', summary: [] }, { type: 'function_call', call_id: 't1', name: 'lookup', arguments: '{"id":"a"}' }]);
  } });
  const first = await client.complete([{ role: 'user', content: 'original task' }], [tool], AbortSignal.timeout(5000));
  assert.equal(requests.length, 1); assert.equal(requests[0].input[0].content[0].text, 'original task'); assert.deepEqual(requests[0].tools.map((t: any) => t.name), ['lookup']);
  assert.equal(first.tool_calls[0].id, 't1'); assert.equal(first.usage!.providerId, 'openai-app-server');
  assert.equal(JSON.stringify(first).includes('synthetic-opaque'), false); assert.equal(usageCost(first.usage), null);
  const wire = client.assistantMessage(first); const continued = lunaInput([wire, { role: 'tool', tool_call_id: 't1', content: 'actual result' }]);
  assert.equal(continued[0].encrypted_content, 'synthetic-opaque'); assert.equal(continued[2].output, 'actual result');
  client.invalidateBoundary(); assert.equal(client.assistantMessage(first).reasoning_content, undefined);
});
test('rejects undeclared native execution, model fallback, partial output, and output overflow with known usage', async () => {
  for (const [output, tokens, model, status, code] of [
    [[{ type: 'function_call', call_id: 'bad', name: 'exec_command', arguments: '{}' }], 20, LUNA_MODEL, 'completed', 'protocol'],
    [[answer('wrong')], 20, 'gpt-5.6-sol', 'completed', 'model_mismatch'],
    [[answer('partial')], 20, LUNA_MODEL, 'incomplete', 'output_length'],
    [[answer('overflow')], 300, LUNA_MODEL, 'completed', 'output_length'],
  ] as const) {
    const client = new AppServerLunaClient({ executable: process.execPath, spawn: childSpawn, fetcher: async () => stream([...output], tokens, model, status) });
    await assert.rejects(client.complete([{ role: 'user', content: 'task' }], [tool], AbortSignal.timeout(5000), undefined, { maxOutputTokens: 256 }), (error: any) => error.code === code);
  }
});
test('cancellation aborts the actual upstream and a boundary invalidation cannot deliver a result', async () => {
  let started!: () => void; const ready = new Promise<void>(yes => { started = yes; }); let aborted = false;
  const client = new AppServerLunaClient({ executable: process.execPath, spawn: childSpawn, fetcher: async (_url, init) => {
    started(); return new Promise((_yes, no) => init!.signal!.addEventListener('abort', () => { aborted = true; no(init!.signal!.reason); }, { once: true }));
  } });
  const pending = client.complete([{ role: 'user', content: 'task' }], [], AbortSignal.timeout(5000));
  await ready; client.invalidateBoundary(); await assert.rejects(pending, (error: any) => error.name === 'AbortError'); assert.equal(aborted, true);
});
test('production default stays DeepSeek; only explicit host test selection substitutes Luna', () => {
  const previous = process.env.ZAICHANG_MODEL_TRANSPORT;
  try { delete process.env.ZAICHANG_MODEL_TRANSPORT; assert.equal(createModelClient('', LUNA_MODEL).providerMetadata().model, 'deepseek-flash');
    process.env.ZAICHANG_MODEL_TRANSPORT = 'luna-app-server-test'; const metadata = createModelClient('', 'deepseek-flash').providerMetadata();
    assert.equal(metadata.model, LUNA_MODEL); assert.equal(metadata.temporaryTestSubstitute, true); assert.equal(metadata.limits.outputEnforcement, 'host_post_completion');
  } finally { if (previous === undefined) delete process.env.ZAICHANG_MODEL_TRANSPORT; else process.env.ZAICHANG_MODEL_TRANSPORT = previous; }
});
