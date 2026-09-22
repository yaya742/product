import test from 'node:test';
import assert from 'node:assert/strict';
import { readSSE, DeepSeekClient, ProviderError, strictDialect, coalesceUserTextParts, type ModelWireMessage } from '../../src/main/provider';
import { bindModelSemantics } from '../../src/main/memory/model';
import { Store } from '../../src/main/store';

test('adjacent user text parts coalesce without mutating history or moving text across an image', () => {
  const messages: ModelWireMessage[] = [{ role: 'user', content: [{ type: 'text', text: '完整宿主资料' }, { type: 'text', text: '完整用户原话' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } }, { type: 'text', text: '图后补充' }] }];
  const original = structuredClone(messages);
  const normalized = coalesceUserTextParts(messages);
  assert.deepEqual(messages, original);
  assert.deepEqual(normalized[0].content, [{ type: 'text', text: '完整宿主资料\n\n完整用户原话' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } }, { type: 'text', text: '图后补充' }]);
});

test('a length-limited response rejects incomplete tool arguments and preserves separately streamed usage', async () => {
  const usage = { prompt_tokens: 180, completion_tokens: 16384, total_tokens: 16564 };
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'partial', function: { name: 'write', arguments: '{"value":' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
    { choices: [], usage },
  ];
  const client = new DeepSeekClient('synthetic', 'deepseek-flash', (async () => new Response(chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n')) as typeof fetch);
  await assert.rejects(client.complete([], [], new AbortController().signal, undefined, { thinking: 'enabled', maxOutputTokens: 16384 }), error => {
    assert.ok(error instanceof ProviderError); assert.equal(error.code, 'output_length'); assert.deepEqual(error.usage, usage);
    assert.ok(!JSON.stringify(error).includes('partial')); return true;
  });
});

test('INV-15 SSE frames preserve multiline data, UTF-8 chunk boundaries and explicit replay IDs', async () => {
  const bytes = new TextEncoder().encode(
    'id: one\r\ndata: {"值":\r\ndata: "中文🧭"}\r\n\r\nid: one\ndata: {"值":"中文🧭"}\n\nid: two\ndata: [DONE]\n\n',
  );
  const seen: string[] = [];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
        controller.close();
      },
    }),
  );
  await readSSE(response, (data) => seen.push(data));
  assert.equal(seen.length, 2);
  assert.equal(JSON.parse(seen[0]).值, '中文🧭');
  assert.equal(seen[1], '[DONE]');
});

test('larger declared output budgets preserve complete protocol text beyond the legacy character cap', async () => {
  const opaque = 'protocol-state '.repeat(5000), visible: string[] = [];
  const fetcher = async () => new Response(
    'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: opaque } }] }) + '\n\n'
    + 'data: ' + JSON.stringify({ choices: [{ delta: { content: '核对完成' }, finish_reason: 'stop' }] }) + '\n\n'
    + 'data: [DONE]\n\n',
  );
  const client = new DeepSeekClient('synthetic', 'deepseek-flash', fetcher as typeof fetch);
  const result = await client.complete([{ role: 'user', content: '合成协议检查' }], [], new AbortController().signal, text => visible.push(text), { thinking: 'enabled', maxOutputTokens: 16384 });
  assert.equal(client.assistantMessage(result).reasoning_content, opaque);
  assert.deepEqual(visible, ['核对完成']);
  const smaller = new DeepSeekClient('synthetic', 'deepseek-flash', fetcher as typeof fetch);
  await assert.rejects(smaller.complete([], [], new AbortController().signal, undefined, { thinking: 'enabled', maxOutputTokens: 4096 }), /协议状态超过/);
  client.invalidateBoundary(); assert.equal(client.assistantMessage(result).reasoning_content, undefined);
});
test('INV-15 cancellation interrupts a stalled response body rather than waiting indefinitely', async () => {
  const controller = new AbortController(),
    response = new Response(new ReadableStream({ start() {} }));
  const pending = readSSE(response, () => {}, controller.signal);
  controller.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(pending, /stop/);
});
test('INV-15 strict conversion rejects open dictionaries and keeps original local argument semantics', async () => {
  assert.throws(
    () => strictDialect({ type: 'object', additionalProperties: { type: 'string' } }),
    /不能等价转换/,
  );
  const dialect = strictDialect({
    type: 'object',
    properties: { required: { type: 'string', minLength: 1 }, optional: { type: 'integer' } },
    required: ['required'],
  });
  assert.deepEqual(dialect.required, ['required', 'optional']);
  assert.equal((dialect.properties as any).required.minLength, undefined);
  assert.equal(dialect.additionalProperties, false);
  let request: any;
  const client = new DeepSeekClient('synthetic', 'deepseek-flash', (async (url, init) => {
    request = { url, payload: JSON.parse(String(init?.body)) };
    return new Response(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'a',
                    function: { name: 'read', arguments: '{"required":"hello","optional":null}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  }) as typeof fetch);
  const result = await client.complete(
    [],
    [
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'read',
          parameters: {
            type: 'object',
            properties: { required: { type: 'string' }, optional: { type: 'integer' } },
            required: ['required'],
          },
        },
      },
    ],
    new AbortController().signal,
    undefined,
    { strict: true },
  );
  assert.equal(request.url, 'https://api.deepseek.com/beta/chat/completions');
  assert.equal(request.payload.tools[0].function.strict, true);
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), { required: 'hello' });
});

test('current DeepSeek route is fixed and preserves joint text-image content', async () => {
  let request: any;
  const client = new DeepSeekClient(
    'synthetic',
    'retired-or-user-supplied-alias',
    (async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(
        'data: ' +
          JSON.stringify({ choices: [{ delta: { content: '右侧通行' }, finish_reason: 'stop' }] }) +
          '\n\ndata: [DONE]\n\n',
      );
    }) as typeof fetch,
  );
  const content = [
    { type: 'text' as const, text: '请根据图片回答。' },
    {
      type: 'image_url' as const,
      image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' },
    },
  ];
  await client.complete(
    [{ role: 'user', content }],
    [],
    new AbortController().signal,
  );
  assert.equal(request.model, 'deepseek-flash');
  assert.deepEqual(request.messages[0].content, content);
  assert.deepEqual(client.providerMetadata().capabilities.modalities, ['text', 'image']);
});

test('INV-15 model-facing work schema avoids recursive JSON dialect while local validation remains strict', () => {
  const store = new Store(':memory:');
  try {
    store.saveSettings({ mode: 'deepseek', memoryEnabled: false });
    const run = store.runtime.begin(
      '请比较两个本地方案。',
      'protocol-work-schema',
      'protocol-work-session',
      new AbortController().signal,
    );
    const spec = store.runtime
      .toolSpecs(run)
      .find((item) => item.function.name === 'update_work_state');
    assert.ok(spec);
    const serialized = JSON.stringify(spec.function.parameters);
    assert.equal(serialized.includes('"$defs"'), false);
    assert.equal(serialized.includes('"oneOf"'), false);
    assert.ok((spec.function.parameters as any).properties.operation.enum.includes('reference_option'));
  } finally {
    store.close();
  }
});
test('INV-15 reasoning without a tool call is retained for required protocol continuation but never as enumerable result data', async () => {
  const client = new DeepSeekClient(
    'synthetic',
    'deepseek-flash',
    (async () =>
      new Response(
        'data: ' +
          JSON.stringify({
            choices: [
              { delta: { reasoning_content: 'OPAQUE_CANARY', content: '答复' }, finish_reason: 'stop' },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
      )) as typeof fetch,
  );
  const result = await client.complete(
    [],
    [
      {
        type: 'function',
        function: { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } },
      },
    ],
    new AbortController().signal,
    undefined,
    { thinking: 'enabled' },
  );
  assert.ok(!JSON.stringify(result).includes('OPAQUE_CANARY'));
  assert.equal(client.assistantMessage(result).reasoning_content, 'OPAQUE_CANARY');
  client.invalidateBoundary();
  assert.equal(client.assistantMessage(result).reasoning_content, undefined);
});

test('INV-15 thinking+tool continuation carries opaque reasoning once, then boundary invalidation drops it', async () => {
  const requests: any[] = [];
  let round = 0;
  const client = new DeepSeekClient(
    'synthetic',
    'deepseek-flash',
    (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      round++;
      const payload =
        round === 1
          ? {
              choices: [
                {
                  delta: {
                    reasoning_content: 'OPAQUE_TOOL_STATE',
                    tool_calls: [
                      { index: 0, id: 'call-1', function: { name: 'read', arguments: '{}' } },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }
          : {
              choices: [
                {
                  delta: { reasoning_content: 'OPAQUE_FINAL_STATE', content: '完成' },
                  finish_reason: 'stop',
                },
              ],
            };
      return new Response(
        'data: ' + JSON.stringify(payload) + '\n\ndata: [DONE]\n\n',
      );
    }) as typeof fetch,
  );
  const signal = new AbortController().signal;
  const tools = [
    {
      type: 'function' as const,
      function: { name: 'read', description: 'read', parameters: { type: 'object' } },
    },
  ];
  const first = await client.complete([{ role: 'user', content: '查一下' }], tools, signal, undefined, {
    thinking: 'enabled',
  });
  const firstAssistant = client.assistantMessage(first);
  assert.equal(firstAssistant.reasoning_content, 'OPAQUE_TOOL_STATE');
  const second = await client.complete(
    [
      { role: 'user', content: '查一下' },
      firstAssistant,
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
    ],
    tools,
    signal,
    undefined,
    { thinking: 'enabled' },
  );
  assert.equal(requests[1].messages[1].reasoning_content, 'OPAQUE_TOOL_STATE');
  // A later user turn with tools still needs the preceding terminal reasoning.
  assert.equal(client.assistantMessage(second).reasoning_content, 'OPAQUE_FINAL_STATE');
  client.invalidateBoundary();
  assert.equal(client.assistantMessage(first).reasoning_content, undefined);
});

test('INV-15 provider metadata reports the actual endpoint/model and verified host limits without a model default', () => {
  const client = new DeepSeekClient('synthetic', 'retired-or-user-supplied-alias', fetch, { contextTokens: 128000 });
  const normal = client.providerMetadata({ thinking: 'disabled' });
  const strict = client.providerMetadata({ thinking: 'enabled', strict: true });
  assert.equal(normal.endpoint, 'https://api.deepseek.com/chat/completions');
  assert.equal(strict.endpoint, 'https://api.deepseek.com/beta/chat/completions');
  assert.equal(normal.model, 'deepseek-flash');
  assert.equal(normal.protocol, 'chat-completions');
  assert.equal(normal.protocolVersion, 'v1');
  assert.equal(normal.limits.contextTokens, 128000);
  assert.notEqual(`${normal.protocol}/${normal.protocolVersion}`, 'legacy-model-alias-v1');
});

test('INV-15 structured memory extraction performs at most one tool-free format repair and marks failure', async () => {
  const event = {
    id: 'event-1',
    contentVersion: 1,
    subjectId: 'student-a',
    worldId: 'real',
    authority: 'user_statement',
  } as any;
  const span = { id: 'span-1', start: 0, end: 4, text: '测试原文' };
  const contract = {
    scope: {},
    now: '2026-09-14T06:00:00.000Z',
    timeZone: 'Asia/Shanghai',
  } as any;
  const policy = { validate: () => ({}) } as any;

  const memory: any = {};
  const calls: { tools: number; options: unknown }[] = [];
  bindModelSemantics(memory, policy, contract, (async (
    _messages: unknown,
    tools: unknown[],
    _signal: AbortSignal,
    _onText?: unknown,
    options?: unknown,
  ) => {
    calls.push({ tools: tools.length, options });
    return calls.length === 1
      ? { content: '{not-json', tool_calls: [] }
      : { content: '{"status":"no_personal_fact","changes":[]}', tool_calls: [] };
  }) as any);
  const recovered = await memory.extractor(event, span, new AbortController().signal);
  assert.equal(recovered.formatRepair, 'recovered');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.tools), [0, 0]);
  assert.deepEqual(calls[1].options, { thinking: 'enabled', maxOutputTokens: 16384, phase: 'memory_extract' });

  const failedMemory: any = {};
  let failedCalls = 0;
  bindModelSemantics(failedMemory, policy, contract, (async () => {
    failedCalls++;
    return { content: 'still-not-json', tool_calls: [] };
  }) as any);
  await assert.rejects(
    () => failedMemory.extractor(event, span, new AbortController().signal),
    /格式修复失败/,
  );
  assert.equal(failedCalls, 2);
});
