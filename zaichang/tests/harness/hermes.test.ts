import test from 'node:test';
import assert from 'node:assert/strict';
import { runHermes, HERMES_COMMIT } from '../../src/main/runtime/hermes';

test('repeated failures retain the native warning while permitting independent answers', async () => {
  let calls = 0, toolCalls = 0;
  const result = await runHermes({ runId: 'host-failure-guidance', epoch: 1, taskVersion: 1, system: 'Product assistant.', userMessage: 'Investigate if useful, then explain the available answer.', history: [], thinking: 'enabled', signal: AbortSignal.timeout(30000), validate() {},
    tools: [{ type: 'function', function: { name: 'read_value', description: 'Controlled read fixture.', parameters: { type: 'object', properties: { attempt: { type: 'integer' } }, required: ['attempt'] } } }],
    model: async request => {
      if (++calls <= 3) return { assistant: { role: 'assistant', content: null, tool_calls: [{ id: 'failed-read-' + calls, type: 'function', function: { name: 'read_value', arguments: JSON.stringify({ attempt: calls }) } }] } };
      const output = String(request.messages.filter(m => m.role === 'tool').at(-1)?.content);
      assert.ok(output.includes('same_tool_failure_warning'));
      assert.ok(output.includes('answer independent requests'));
      assert.ok(!output.includes('Do not switch to text-only replies'));
      return { assistant: { role: 'assistant', content: 'The read failed; the independent explanation is still available.' } };
    },
    tool: async () => { toolCalls++; return { status: 'failed', error: 'The same controlled source remains unavailable.' }; },
  });
  assert.equal(calls, 4); assert.equal(toolCalls, 3); assert.ok(result.content.includes('independent explanation'));
});

test('pinned real AIAgent calls host tool and consumes its observation, with no native tools', async () => {
  const observed: any[] = [], events: any[] = [];
  let calls = 0, tools = 0;
  const result = await runHermes({
    runId: 'compatibility-read', epoch: 1, taskVersion: 1,
    system: 'You are the product assistant. Use the available read tool.',
    userMessage: 'Read the current room and report it.', history: [], thinking: 'enabled',
    tools: [{ type: 'function', function: { name: 'read_room', description: 'Read current room.', parameters: { type: 'object', properties: {} } } }],
    signal: AbortSignal.timeout(40000), validate: () => {}, event: e => events.push(e),
    model: async request => {
      calls++; observed.push(request);
      assert.deepEqual(request.thinking, { type: 'enabled' });
      assert.equal(request.messages[0].content, 'You are the product assistant. Use the available read tool.');
      assert.deepEqual(request.tools?.map(t => t.function.name), ['read_room']);
      if (calls === 1) return { assistant: { role: 'assistant', content: null, reasoning_content: 'Need fresh evidence.', tool_calls: [{ id: 'call-room', type: 'function', function: { name: 'read_room', arguments: '{}' } }] } };
      assert.ok(request.messages.some(m => m.role === 'tool' && String(m.content).includes('ROOM-527')));
      return { assistant: { role: 'assistant', content: 'Current room is ROOM-527.', reasoning_content: 'Used the actual room observation.' } };
    },
    tool: async (name, args) => { tools++; assert.equal(name, 'read_room'); assert.deepEqual(args, {}); return { room: 'ROOM-527', version: 3 }; },
  });
  assert.equal(result.content, 'Current room is ROOM-527.');
  assert.equal(calls, 2); assert.equal(tools, 1);
  assert.equal(events.find(e => e.kind === 'run.ready')?.payload.commit, HERMES_COMMIT);
});

test('cancellation interrupts an outstanding model call and rejects its late tool proposal', async () => {
  const controller = new AbortController();
  let release!: (value: any) => void;
  let started!: () => void;
  const called = new Promise<void>(resolve => { started = resolve; });
  let toolCalls = 0;
  const pending = runHermes({
    runId: 'compatibility-cancel', epoch: 2, taskVersion: 1, system: 'Host cancellation probe.',
    userMessage: 'Read a value.', history: [], tools: [], thinking: 'enabled',
    signal: controller.signal, validate: () => {},
    model: async () => { started(); return new Promise(resolve => { release = resolve; }); },
    tool: async () => { toolCalls++; return {}; },
  });
  await called;
  controller.abort(new DOMException('cancelled_by_user', 'AbortError'));
  await assert.rejects(pending, /cancelled_by_user/);
  release({ assistant: { role: 'assistant', content: null, tool_calls: [{ id: 'late', type: 'function', function: { name: 'late_write', arguments: '{}' } }] } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(toolCalls, 0);
});

test('a changed permission version blocks the next model/tool boundary and a clean run can resume', async () => {
  let valid = true, tools = 0;
  await assert.rejects(runHermes({
    runId: 'compatibility-revoke', epoch: 3, taskVersion: 1, system: 'Scope probe.',
    userMessage: 'Read.', history: [], tools: [], thinking: 'enabled', signal: AbortSignal.timeout(20000),
    validate: () => { if (!valid) throw new Error('permission_epoch_changed'); },
    model: async () => { valid = false; return { assistant: { role: 'assistant', content: 'A stale answer.' } }; },
    tool: async () => { tools++; return {}; },
  }), /permission_epoch_changed/);
  assert.equal(tools, 0);
  const resumed = await runHermes({
    runId: 'compatibility-resume', epoch: 4, taskVersion: 2, system: 'Scope probe.',
    userMessage: 'Continue with only this message.', history: [], tools: [], thinking: 'enabled',
    signal: AbortSignal.timeout(20000), validate: () => {},
    model: async request => { assert.equal(request.messages.length, 2); return { assistant: { role: 'assistant', content: 'Clean continuation.' } }; },
    tool: async () => { throw new Error('No tools authorized.'); },
  });
  assert.equal(resumed.content, 'Clean continuation.');
});

test('native Hermes delegation creates independent worker loops and the parent consumes their observed results', async () => {
  const root = 'native-delegation';
  const tasks = [{ title: 'left', instruction: 'Read the left source.' }, { title: 'right', instruction: 'Read the right source.' }];
  const children = new Map<string, { side: string; calls: number; tools: number }>();
  const statuses: string[] = [];
  let roots = 0, active = 0, maxActive = 0;
  const read = { type: 'function' as const, function: { name: 'read_source', description: 'Read the actual source token.', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
  const delegate = { type: 'function' as const, function: { name: 'delegate', description: 'Run independent read-only tasks.', parameters: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, instruction: { type: 'string' } }, required: ['title', 'instruction'] } } }, required: ['tasks'] } } };
  const values: Record<string, string> = { left: 'OBSERVED_LEFT_734', right: 'OBSERVED_RIGHT_916' };
  const result = await runHermes({
    runId: root, epoch: 1, taskVersion: 1, modelIdentity: { model: 'gpt-5.6-luna', providerId: 'openai-app-server', temporaryTestSubstitute: true }, system: 'Parent product assistant.', userMessage: 'Use two independent tasks and combine the observed tokens.', history: [], tools: [read, delegate], thinking: 'enabled', maxIterations: 12, signal: AbortSignal.timeout(60000), validate: () => {},
    model: async request => {
      const child = children.get(String(request.agent_id));
      assert.equal(request.model, 'gpt-5.6-luna');
      if (!child) {
        if (++roots === 1) return { assistant: { role: 'assistant', content: null, tool_calls: [{ id: 'native-delegate-call', type: 'function', function: { name: 'delegate', arguments: JSON.stringify({ tasks }) } }] } };
        const result = String(request.messages.filter(m => m.role === 'tool').at(-1)?.content);
        assert.ok(result.includes(values.left), result); assert.ok(result.includes(values.right), result);
        const rows = JSON.parse(result).results;
        assert.ok(rows.every((row: any) => row.model === 'gpt-5.6-luna' && row.providerId === 'openai-app-server' && row.temporaryTestSubstitute));
        assert.ok(rows.every((row: any) => row.cost_status !== 'unknown' || row.cost_usd === null));
        return { assistant: { role: 'assistant', content: values.left + ' ' + values.right } };
      }
      assert.equal(request.messages[0].content, 'Independent worker: ' + child.side);
      assert.deepEqual(request.tools?.map(t => t.function.name), ['read_source']);
      child.calls++;
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 80)); active--;
      if (child.calls === 1) return { assistant: { role: 'assistant', content: null, tool_calls: [{ id: 'read-' + child.side, type: 'function', function: { name: 'read_source', arguments: '{}' } }] } };
      const observation = JSON.parse(String(request.messages.filter(m => m.role === 'tool').at(-1)?.content));
      assert.equal(observation.token, values[child.side]);
      return { assistant: { role: 'assistant', content: observation.token } };
    },
    tool: async (name, _args, _callId, id) => { const child = children.get(id!); assert.ok(child); assert.equal(name, 'read_source'); child.tools++; return { token: values[child.side] }; },
    children: {
      authorize: async args => { assert.deepEqual(args, { tasks }); },
      open: async task => { const id = 'worker-' + task.title; children.set(id, { side: task.title, calls: 0, tools: 0 }); return { id, system: 'Independent worker: ' + task.title, tools: [read] }; },
      event: (id, state) => statuses.push(id + ':' + state), result: async () => {},
    },
  });
  assert.equal(result.content, values.left + ' ' + values.right);
  assert.equal(children.size, 2); assert.equal(maxActive, 2);
  for (const child of children.values()) { assert.equal(child.calls, 2); assert.equal(child.tools, 1); }
  assert.ok(statuses.includes('worker-left:produced')); assert.ok(statuses.includes('worker-right:produced'));
});

test('host-normalized image and text pass through the real engine in one user message without caption fallback', async () => {
  const content = [{ type: 'text' as const, text: '按这幅图中的左右关系回答。' }, { type: 'image_url' as const, image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } }];
  let calls = 0;
  await runHermes({ runId: 'native-image', epoch: 1, taskVersion: 1, system: 'Product assistant.', userMessage: content, history: [], tools: [], thinking: 'enabled', signal: AbortSignal.timeout(30000), validate: () => {},
    model: async request => { calls++; assert.deepEqual(request.messages.at(-1)?.content, content); return { assistant: { role: 'assistant', content: 'Mechanism fixture.' } }; },
    tool: async () => { throw new Error('No tool or transcription was authorized.'); },
  });
  assert.equal(calls, 1);
});

test('one native worker failure leaves its sibling result available to the parent', async () => {
  const root = 'partial-native', workers = new Map<string, string>(), states: string[] = [];
  let parentCalls = 0;
  const tasks = [{ title: 'good', instruction: 'Report your available finding.' }, { title: 'failed', instruction: 'Attempt your independent source.' }];
  const result = await runHermes({ runId: root, epoch: 1, taskVersion: 1, system: 'Parent.', userMessage: 'Use two independent workers.', history: [], thinking: 'enabled', tools: [{ type: 'function', function: { name: 'delegate', description: 'Delegate.', parameters: { type: 'object' } } }], signal: AbortSignal.timeout(45000), validate: () => {},
    model: async request => {
      const worker = workers.get(String(request.agent_id));
      if (worker === 'failed') throw Object.assign(new Error('controlled source/model failure'), { code: 'fixture_failure' });
      if (worker === 'good') return { assistant: { role: 'assistant', content: 'SIBLING_EVIDENCE_428' } };
      if (++parentCalls === 1) return { assistant: { role: 'assistant', content: null, tool_calls: [{ id: 'fanout', type: 'function', function: { name: 'delegate', arguments: JSON.stringify({ tasks }) } }] } };
      const observed = String(request.messages.filter(m => m.role === 'tool').at(-1)?.content);
      assert.ok(observed.includes('SIBLING_EVIDENCE_428')); assert.ok(observed.includes('failed'));
      return { assistant: { role: 'assistant', content: 'One source is available; the other failed.' } };
    }, tool: async () => { throw new Error('No tools for these fixture workers.'); },
    children: { authorize: async () => {}, open: async task => { const id = 'child-' + task.title; workers.set(id, task.title); return { id, system: 'Independent: ' + task.title, tools: [] }; }, event: (id, status) => states.push(id + ':' + status), result: async () => {} },
  });
  assert.equal(result.content, 'One source is available; the other failed.');
  assert.ok(states.includes('child-good:produced')); assert.ok(states.includes('child-failed:failed'));
});

test('cancelling a native delegation prevents late worker output from reaching any tool', async () => {
  const root = 'cancel-native', controller = new AbortController();
  const releases: ((value: any) => void)[] = [];
  let ready!: () => void, tools = 0;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const task = { title: 'waiting', instruction: 'Wait for the current source.' };
  const pending = runHermes({ runId: root, epoch: 1, taskVersion: 1, system: 'Parent.', userMessage: 'Delegate.', history: [], thinking: 'enabled', tools: [{ type: 'function', function: { name: 'delegate', description: 'Delegate.', parameters: { type: 'object' } } }], signal: controller.signal, validate: () => {},
    model: async request => {
      if (request.agent_id !== root) { ready(); return new Promise(resolve => releases.push(resolve)); }
      return { assistant: { role: 'assistant', content: null, tool_calls: [{ id: 'wait-child', type: 'function', function: { name: 'delegate', arguments: JSON.stringify({ tasks: [task] }) } }] } };
    }, tool: async () => { tools++; return {}; },
    children: { authorize: async () => {}, open: async () => ({ id: 'waiting-worker', system: 'Worker.', tools: [] }), event() {}, result: async () => {} },
  });
  await Promise.race([started, pending.then(() => { throw new Error('Unexpected early completion'); })]);
  controller.abort(new DOMException('cancel_native_tree', 'AbortError'));
  await assert.rejects(pending, /cancel_native_tree/);
  for (const release of releases) release({ assistant: { role: 'assistant', content: null, tool_calls: [{ id: 'late', type: 'function', function: { name: 'unapproved_write', arguments: '{}' } }] } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(tools, 0);
});

test('native compression uses the host model exit and keeps the middle constraint available', async () => {
  const history = Array.from({ length: 50 }, (_, index) => [
    { role: 'user' as const, content: `Historical source ${index}: ` + 'permitted background material '.repeat(90) + (index === 12 ? ' MIDDLE_CONSTRAINT_827 must remain.' : '') },
    { role: 'assistant' as const, content: 'Previous response, not a confirmed fact. '.repeat(15) },
  ]).flat();
  const phases: string[] = [];
  const result = await runHermes({ runId: 'native-compression', epoch: 1, taskVersion: 1, system: 'Product assistant.', userMessage: 'Continue with the retained constraint.', history, tools: [], thinking: 'enabled', compression: { enabled: true, thresholdTokens: 16000, forceInitial: true }, signal: AbortSignal.timeout(45000), validate: () => {},
    model: async request => {
      phases.push(String(request.phase || 'main'));
      if (request.phase === 'compression') {
        assert.ok(JSON.stringify(request.messages).includes('MIDDLE_CONSTRAINT_827'));
        assert.deepEqual(request.tools, []);
        return { assistant: { role: 'assistant', content: '## Historical task snapshot\nThe historical source records the condition MIDDLE_CONSTRAINT_827.\n## Active state\nUse original sources for details; no actions were executed.' } };
      }
      assert.ok(JSON.stringify(request.messages).includes('MIDDLE_CONSTRAINT_827'));
      return { assistant: { role: 'assistant', content: 'The retained condition remains available.' } };
    }, tool: async () => { throw new Error('No tools in compression fixture.'); },
  });
  assert.ok((result.compactions || 0) >= 1);
  assert.ok(phases.includes('compression')); assert.equal(phases.at(-1), 'main');
});
