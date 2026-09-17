import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Fixture, supported } from './support';
import type { RuntimeCallbacks } from '../../src/main/runtime/coordinator';
import { localCloudRestriction, parseTurnControls } from '../../src/main/runtime/turn-controls';
import { Harness } from '../../src/main/harness';
import { DeepSeekClient, ProviderError, type ModelWireMessage } from '../../src/main/provider';
import { withHostReplies } from './support';
import { controlProposal } from './support';
import { checkLocalDelegation } from '../../src/main/runtime/action-delegation';
import { bindModelSemantics } from '../../src/main/memory/model';
import { ToolRegistry } from '../../src/main/tools';

const callbacks: RuntimeCallbacks = { step() {}, plan() {}, action() {}, changed() {}, delegate: async () => { throw new Error('No delegation permitted by this test.'); } };

test('invalid control structure still permits independent current-input help without persistence or private reads', async () => {
  const f = new Fixture(); f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true;
  let controls = 0, mains = 0, latest: any;
  const harness = new Harness(f.store, () => 'synthetic', event => { if (event.type === 'message' && event.message.role === 'assistant') latest = event.message; }, () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async (_messages, tools) => {
      if (tools.some(spec => spec.function.name === 'propose_turn_controls')) { controls++; return { content: '', tool_calls: [{ id: 'invalid-controls', type: 'function', function: { name: 'propose_turn_controls', arguments: '{}' } }] }; }
      mains++; return { content: '8', tool_calls: [] };
    };
    return client;
  });
  try {
    harness.start(undefined, '这条不保存，只告诉我3加5。'); await harness.idle();
    assert.equal(controls, 2); assert.equal(mains, 1); assert.equal(latest.content, '8'); assert.equal(latest.status, 'done');
    assert.equal(f.repo.watermarks().received, 0); assert.equal(f.store.agenda().length, 0); assert.equal(f.store.conversations().length, 0);
    assert.ok(f.repo.access.every(access => access.source === 'current'));
  } finally { await harness.stop(); f.close(); }
});

test('a native child does not inherit a parent private dependency notice', async () => {
  const f = new Fixture(); f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true;
  let mains = 0, children = 0;
  const harness = new Harness(f.store, () => 'synthetic', () => {}, () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async (messages, _tools, _signal, _text, options) => {
      if (options?.actorId) { children++; assert.ok(!JSON.stringify(messages).includes('CANARY_PARENT_NOTICE_963')); return { content: '4', tool_calls: [] }; }
      if (++mains === 1) {
        f.store.runtime.lastSession!.dependencyNotices = [{ text: 'CANARY_PARENT_NOTICE_963' }];
        return { content: '', tool_calls: [{ id: 'delegate-notice-test', type: 'function', function: { name: 'delegate', arguments: JSON.stringify({ tasks: [{ title: '独立计算', instruction: '只计算二加二并返回结果，不读取其他来源。', sources: [] }] }) } }] };
      }
      return { content: '4', tool_calls: [] };
    };
    return withHostReplies(client);
  });
  try { harness.start(undefined, '开一个独立计算任务求2+2，不给它私人背景。'); await harness.idle(); assert.equal(children, 1); }
  finally { await harness.stop(); f.close(); }
});

test('a child cannot reuse the parent availability projection beyond its own source ceiling', async () => {
  const f = new Fixture();
  try {
    const run = f.store.runtime.begin('核对本人忙闲，另做一次独立运算。', 'projection-parent', 'projection-parent', new AbortController().signal, { semantic: controlProposal({ release: { recipient: '小组', purpose: '协调忙闲', allowedFacts: [], tone: '自然', useAvailability: true } }) });
    const scope = f.store.runtime.childScope(run, { title: '计算', instruction: '只计算，不读取个人来源。', sources: [] });
    const child = { ...run, ingress: { ...run.ingress, contract: { ...run.ingress.contract, scope } } };
    const before = f.repo.access.length;
    const result: any = await f.store.runtime.executeTool(child, 'availability_projection', { from: '2026-09-15T00:00:00Z', to: '2026-09-15T04:00:00Z' }, { ...callbacks, verifyReadPurpose: async () => ({ allowed: true, sourceQuote: '核对本人忙闲', reason: 'Even a positive semantic verdict cannot enlarge a child scope.' }) }, true);
    assert.equal(result.status, 'forbidden'); assert.equal(f.repo.access.length, before);
  } finally { f.close(); }
});

test('a mixed-purpose next turn cannot inherit cached private context before its read-purpose check', async () => {
  const f = new Fixture(); f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true;
  let stage = 1, checked = false;
  const harness = new Harness(f.store, () => 'synthetic', () => {}, () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async messages => {
      if (stage === 2) { checked = true; assert.ok(!JSON.stringify(messages).includes('CANARY_CACHED_PRIVATE_962')); }
      return { content: '就当前提供的信息继续。', tool_calls: [] };
    };
    return withHostReplies(client, controlProposal({ subject: stage === 1 ? 'self' : 'mixed' }));
  });
  try {
    const { sessionId } = harness.start(undefined, '私人背景 CANARY_CACHED_PRIVATE_962。'); await harness.idle();
    stage = 2; harness.start(sessionId, '帮同学看他给的材料，也看看我这次提供的那一段。'); await harness.idle();
    assert.equal(checked, true);
  } finally { await harness.stop(); f.close(); }
});

test('two substantive correction continuations can finish within one shared budget without publishing rejected replies', async () => {
  const f = new Fixture(); f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true;
  let calls = 0, reviews = 0, latest: any; const published: string[] = [];
  const tool = (name: string, args: unknown) => ({ content: '', tool_calls: [{ id: 'bounded-' + name, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });
  const harness = new Harness(f.store, () => 'synthetic', event => { if (event.type === 'message' && event.message.role === 'assistant') { latest = event.message; if (event.message.content) published.push(event.message.content); } }, () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async () => {
      if (++calls === 1) return tool('look_up', { source: 'capability', query: 'not-a-connected-service' });
      return { content: calls === 2 ? 'UNSUPPORTED_FACT' : calls === 3 ? 'UNREQUESTED_PROMISE' : '已知部分已说明，外部服务未接通。', tool_calls: [] };
    };
    const wrapped = withHostReplies(client), forward = wrapped.complete.bind(wrapped);
    wrapped.complete = async (...args) => {
      if (args[1][0]?.function.name === 'report_completion_gaps') {
        reviews++; const input = JSON.parse(String(args[0][1].content));
        return tool('report_completion_gaps', { missing: [], contradictions: input.reply === 'UNSUPPORTED_FACT' ? ['Remove the unsupported factual claim.'] : input.reply === 'UNREQUESTED_PROMISE' ? ['Remove the unrequested future promise.'] : [], requests: [] });
      }
      return forward(...args);
    };
    return wrapped;
  });
  try {
    harness.start(undefined, '说明已知情况和服务缺口。'); await harness.idle();
    assert.equal(calls, 4); assert.equal(reviews, 3); assert.equal(latest.status, 'done');
    assert.ok(published.length > 0); assert.ok(published.every(text => text === '已知部分已说明，外部服务未接通。'));
    assert.equal(f.store.agenda().length, 0);
  } finally { await harness.stop(); f.close(); }
});

test('an outward audience proposal gets a bounded review of the current reply recipient without widening an actual draft audience', async () => {
  const { sources: _, ...outward } = controlProposal({ audience: 'group', release: { purpose: '交流', allowedFacts: [], recipient: '外部联系人', tone: '自然', useAvailability: false } });
  let calls = 0;
  const message = '以后可能联系对方，现在只向我解释条件。';
  const result = await parseTurnControls(message, { complete: async messages => {
    calls++; assert.equal(messages.filter(m => m.role === 'user')[0].content, message);
    return { content: '', tool_calls: [{ id: 'audience', type: 'function', function: { name: 'propose_turn_controls', arguments: JSON.stringify(calls === 1 ? outward : { ...outward, audience: 'self', release: null }) } }] };
  } }, new AbortController().signal);
  assert.equal(calls, 2); assert.equal(result.audience, 'self'); assert.equal(result.release, null);
  let draftCalls = 0;
  const kept = await parseTurnControls('现在就给外部联系人起草。', { complete: async () => { draftCalls++; return { content: '', tool_calls: [{ id: 'draft-audience', type: 'function', function: { name: 'propose_turn_controls', arguments: JSON.stringify(outward) } }] }; } }, new AbortController().signal);
  assert.equal(draftCalls, 2); assert.equal(kept.audience, 'group');
});

test('capability search keeps Latin words intact and marks filtered coverage without inventing absence', () => {
  const f = new Fixture();
  try {
    const email = f.store.runtime.broker.catalog(f.scope(), '邮件 发送 email mail');
    assert.equal(email.items.length, 0, 'Latin fragments must not make mail match map');
    assert.equal(email.coverage.matchingOnly, true);
    assert.equal(email.coverage.query, '邮件 发送 email mail');
    const maps = f.store.runtime.broker.catalog(f.scope(), 'map.search');
    assert.ok(maps.items.some(item => item.name === 'map.search'));
    const all = f.store.runtime.broker.catalog(f.scope(), '', 0, 100);
    assert.equal(all.coverage.matchingOnly, false);
    assert.ok(all.items.some(item => item.name === 'local.agenda.save'));
  } finally { f.close(); }
});

test('completion review receives the same scoped capability facts as the actor, separately from filtered search observations', async () => {
  const f = new Fixture(); f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true;
  let calls = 0, reviewed = false, latest: any;
  const harness = new Harness(f.store, () => 'synthetic', event => { if (event.type === 'message' && event.message.role === 'assistant') latest = event.message; }, () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async () => ++calls === 1 ? { content: '', tool_calls: [{ id: 'catalog-search', type: 'function', function: { name: 'look_up', arguments: JSON.stringify({ source: 'capability', query: 'email' }) } }] } : { content: '邮件发送尚未接通，没有提交。', tool_calls: [] };
    const wrapped = withHostReplies(client, controlProposal({ actions: 'none', actionsApplyToWholeTurn: true })), original = wrapped.complete.bind(wrapped);
    wrapped.complete = async (...args) => {
      if (args[1][0]?.function.name === 'report_completion_gaps') {
        const input = JSON.parse(String(args[0][1].content));
        const local = input.hostState.capabilityDirectory.items.find((item: any) => item.name === 'local.agenda.save');
        assert.equal(local.connected, true); assert.equal(local.executableInThisTurn, false);
        assert.equal(input.hostState.actionMode, 'respond');
        assert.deepEqual(input.observations.find((item: any) => item.tool === 'look_up').result.items, []);
        reviewed = true;
      }
      return original(...args);
    };
    return wrapped;
  });
  try { harness.start(undefined, '只说明连接情况，不作提交。'); await harness.idle(); assert.equal(reviewed, true); assert.equal(latest.status, 'done'); assert.equal(f.store.agenda().length, 0); }
  finally { await harness.stop(); f.close(); }
});

test('memory review resolves host identity selectors and provides actionable rejection details only to the model', async () => {
  const f = new Fixture(), steps: any[] = [];
  try {
    const text = '设备恢复后才继续，确切时间还不知道。';
    const run = f.store.runtime.begin(text, 'review-current', 'review-session', new AbortController().signal);
    const diagnostic = 'REVIEW_DETAIL_773: the proposed precise end is unsupported.';
    let checks = 0;
    bindModelSemantics(f.memory, f.policy, run.ingress.contract, async messages => {
      checks++;
      const input = JSON.parse(String(messages[1].content));
      assert.equal(input.candidate.subjectId, f.repo.identity.principalId);
      assert.equal(input.candidate.worldId, 'real');
      assert.equal(input.candidate.subject, undefined); assert.equal(input.candidate.world, undefined);
      return { content: JSON.stringify({ ...supported, supported: false, preservesTime: false, reason: diagnostic }), tool_calls: [] };
    });
    const registry = new ToolRegistry({ ...callbacks, store: f.store, userText: text, currentUserId: 'review-current', child: false, signal: run.signal, runtimeSession: run, step: step => steps.push(step) });
    const result = JSON.parse(await registry.execute('propose_memory_change', JSON.stringify(f.change(run.events[0], { subject: 'self', kind: 'current_state', validTo: '2026-09-15T00:00:00Z' }))));
    assert.equal(checks, 1); assert.equal(result.status, 'failed'); assert.equal(result.code, 'semantic_rejected');
    assert.deepEqual(result.diagnostic.rejectedDimensions, ['supported', 'preservesTime']);
    assert.equal(result.diagnostic.explanation, diagnostic);
    assert.ok(!JSON.stringify(steps).includes('REVIEW_DETAIL_773'));
    assert.equal(f.repo.assertions(f.scope()).length, 0);
  } finally { f.close(); }
});

test('source exclusion repair reports the missing original quote without widening the scope or adding retries', async () => {
  const original = '核对已授权的两份资料，不读取个人历史。';
  const { sources: _, ...proposal } = controlProposal({ sourceExclusions: ['history:self'], sourceBasis: null, basis: ['不读取个人历史。'] });
  let calls = 0;
  const client: Pick<DeepSeekClient, 'complete'> = { complete: async (messages, _tools, _signal, _text, options) => {
    calls++; assert.equal(options?.thinking, 'enabled');
    if (calls === 2) assert.ok(String(messages.at(-1)?.content).includes('required_for_allowlist_or_exclusions'));
    return { content: '', tool_calls: [{ id: 'control-' + calls, type: 'function', function: { name: 'propose_turn_controls', arguments: JSON.stringify({ ...proposal, sourceBasis: calls === 2 ? '不读取个人历史。' : null }) } }] };
  } };
  const result = await parseTurnControls(original, client, new AbortController().signal, { sources: ['current', 'history:self', 'synthetic:packets'], capabilities: [] });
  assert.equal(calls, 2); assert.deepEqual(result.sourceExclusions, ['history:self']); assert.equal(result.sourceAllowlist, null); assert.equal(result.sources, 'unchanged');
});

test('an incomplete control proposal gets at most one clean retry with unchanged thinking and limits', async () => {
  const original = '只看当前材料。';
  const { sources: _, ...proposal } = controlProposal({ sourceBasis: original, sourceAllowlist: ['current'] });
  let calls = 0;
  const client: Pick<DeepSeekClient, 'complete'> = { complete: async (messages, tools, _signal, _text, options) => {
    calls++; assert.equal(options?.thinking, 'enabled'); assert.equal(options.maxOutputTokens, 16384);
    assert.equal(tools.length, 1); assert.equal(messages.filter(m => m.role === 'user')[0].content, original);
    assert.ok(messages.every(m => m.role !== 'assistant'));
    if (calls === 1) throw new ProviderError('Synthetic token exhaustion', false, 'output_length');
    return { content: '', tool_calls: [{ id: 'recovered', type: 'function', function: { name: 'propose_turn_controls', arguments: JSON.stringify(proposal) } }] };
  } };
  assert.equal((await parseTurnControls(original, client, new AbortController().signal)).sources, 'current_only');
  assert.equal(calls, 2);
  let failures = 0;
  const alwaysFails = { complete: async () => { failures++; throw new ProviderError('Still incomplete', false, 'output_length'); } };
  await assert.rejects(parseTurnControls(original, alwaysFails, new AbortController().signal), /Still incomplete/);
  assert.equal(failures, 2);
  let denied = 0;
  await assert.rejects(parseTurnControls(original, { complete: async () => { denied++; throw new ProviderError('No access', false, 'authentication'); } }, new AbortController().signal), /No access/);
  assert.equal(denied, 1);
});

test('native malformed-tool recovery remains within the host output allowance and never executes partial arguments', async () => {
  const f = new Fixture(); f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true;
  let calls = 0, latest: any;
  const harness = new Harness(f.store, () => 'synthetic', event => { if (event.type === 'message' && event.message.role === 'assistant') latest = event.message; }, () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async (_messages, _tools, _signal, _onText, options) => {
      calls++; assert.equal(options?.thinking, 'enabled'); assert.equal(options.maxOutputTokens, 16384);
      if (calls === 1) return { content: '', tool_calls: [{ id: 'bad-json', type: 'function', function: { name: 'prepare_action', arguments: 'not-json' } }] };
      return { content: '没有登记任何事项。', tool_calls: [] };
    };
    return withHostReplies(client);
  });
  try {
    harness.start(undefined, '只讨论，不作登记。'); await harness.idle();
    assert.equal(latest.status, 'done'); assert.equal(calls, 2); assert.equal(f.store.agenda().length, 0);
    assert.deepEqual(latest.contextReceipt.budget.outputLimitAdjustments, [{ requested: 32768, applied: 16384, actor: 'main' }]);
  } finally { await harness.stop(); f.close(); }
});

test('a stated source restriction cannot silently become an unrestricted empty mapping', async () => {
  const original = '只看本次附件，不读旧记录。';
  const { sources: _, ...base } = controlProposal({ sourceBasis: original });
  let calls = 0;
  const client = { complete: async () => { calls++; return { content: '', tool_calls: [{ id: 'scope', type: 'function' as const, function: { name: 'propose_turn_controls', arguments: JSON.stringify({ ...base, sourceAllowlist: calls === 1 ? null : ['current'] }) } }] }; } };
  const repaired = await parseTurnControls(original, client, new AbortController().signal, { sources: ['current', 'history:self'], capabilities: [] });
  assert.equal(calls, 2); assert.equal(repaired.sources, 'current_only');
  const inconsistent = { complete: async () => ({ content: '', tool_calls: [{ id: 'scope', type: 'function' as const, function: { name: 'propose_turn_controls', arguments: JSON.stringify(base) } }] }) };
  await assert.rejects(parseTurnControls(original, inconsistent, new AbortController().signal), /资料范围/);
});

test('source uncertainty gets one bounded review and a genuine unresolved restriction stays restrictive', async () => {
  const original = '那份旧资料先别用，范围我还没说清。';
  const { sources: _, ...proposal } = controlProposal({ sourceBasis: original, uncertain: true, uncertainControls: [{ dimension: 'sources', quote: original }] });
  let calls = 0;
  const client = { complete: async () => { calls++; return { content: '', tool_calls: [{ id: 'uncertainty', type: 'function' as const, function: { name: 'propose_turn_controls', arguments: JSON.stringify(proposal) } }] }; } };
  const result = await parseTurnControls(original, client, new AbortController().signal);
  assert.equal(calls, 2); assert.equal(result.uncertainControls[0].dimension, 'sources');
  const f = new Fixture();
  try {
    const run = f.store.runtime.begin(original, 'uncertain-control', 'uncertain', new AbortController().signal, { semantic: result });
    const scope = f.policy.validate(run.ingress.contract.scope);
    assert.ok(!scope.sources.includes('history:self') && !scope.sources.includes('profile:self'));
  } finally { f.close(); }
});

test('the same host permissions expose the same tools regardless of wording, emotion or requested answer length', () => {
  const f = new Fixture();
  try {
    const rows = ['查询明天第一节课程教室', '弄清明儿头一节在哪个屋上', '烦死了，替我弄明白', '两份都核对清楚，最后只说一句', '先听我说，也请查一下', '帮我分析开会为什么紧张'].map((text, index) => {
      const run = f.store.runtime.begin(text, 'visibility-' + index, 'visibility', new AbortController().signal);
      return f.store.runtime.toolSpecs(run).map(spec => spec.function.name).sort();
    });
    for (const row of rows) assert.deepEqual(row, rows[0]);
    assert.ok(rows[0].includes('look_up')); assert.ok(rows[0].includes('prepare_action'));
    assert.equal(f.repo.work(f.scope()).length, 0, 'ordinary input does not manufacture episodes or obligations');
  } finally { f.close(); }
});

test('current-only scope excludes private sources before transcript, memory or prefetch access', async () => {
  const f = new Fixture();
  try {
    f.ingest('PRIVATE_SHOULD_NOT_BE_READ');
    const start = f.repo.access.length;
    const run = f.store.runtime.begin('只看当前附件。', 'current-only', 'private-test', new AbortController().signal, {
      memoryMode: 'current_sources_only', attachment: { id: 'allowed-file', name: 'material.txt', text: 'Current material.' },
    });
    const pack = await f.store.runtime.compile(run, true);
    assert.ok(!JSON.stringify(pack.data).includes('PRIVATE_SHOULD_NOT_BE_READ'));
    assert.ok(f.repo.access.slice(start).every(access => access.source === 'current'));
    assert.deepEqual(pack.data.history, []);
  } finally { f.close(); }
});

test('an unrequested action is rejected before any agenda, action or outbox mutation', async () => {
  const f = new Fixture();
  try {
    const run = f.store.runtime.begin('分析开会时的紧张。', 'analysis-only', 'analysis', new AbortController().signal);
    const result: any = await f.store.runtime.executeTool(run, 'prepare_action', { title: '会议', detail: '不应创建' }, {
      ...callbacks,
      verifyLocalDelegation: async () => ({ decision: 'not_requested', basis: [], missing: [], reason: 'Only analysis was requested.' }),
    });
    assert.equal(result.saved, false);
    assert.equal(f.store.agenda().length, 0);
    assert.equal(f.store.runtime.actions.list(f.scope()).length, 0);
  } finally { f.close(); }
});

test('a verified point-event delegation commits one real local item and receipt without inventing duration', async () => {
  const f = new Fixture();
  try {
    const text = '明天九点碰头，记下来。';
    const run = f.store.runtime.begin(text, 'point-request', 'point-event', new AbortController().signal);
    const args = { title: '碰头', detail: '结束时间未定', startsAt: '2026-09-15T09:00:00+08:00' };
    const trustedCallbacks = { ...callbacks, verifyLocalDelegation: async () => ({ decision: 'execute_local' as const, basis: [{ id: 'point-request', quote: text }], missing: [], reason: 'Synthetic host authorization; semantic quality is tested separately.' }) };
    const first: any = await f.store.runtime.executeTool(run, 'prepare_action', args, trustedCallbacks);
    const replay: any = await f.store.runtime.executeTool(run, 'prepare_action', args, trustedCallbacks);
    assert.equal(first.saved, true); assert.equal(first.receipt.status, 'confirmed_success');
    assert.equal(replay.item.id, first.item.id); assert.equal(f.store.agenda().length, 1);
    assert.equal(f.store.agenda()[0].durationMinutes, undefined);
    await assert.rejects(f.store.runtime.executeTool(run, 'prepare_action', { ...args, authorized: true }, callbacks));
  } finally { f.close(); }
});

test('cloud sending controls are separate from withholding an external email', () => {
  assert.equal(localCloudRestriction('不要发送到云端，只在本机处理。'), true);
  assert.equal(localCloudRestriction('请先拟草稿，暂时不要发送给老师。'), false);
  assert.equal(localCloudRestriction('先不要把这段上传到服务器。'), true);
});

test('explicit requests have source evidence and cannot self-certify action completion', () => {
  const f = new Fixture();
  try {
    f.ingest('请把读书会记入本地。', 'request-origin');
    const service = f.store.runtime.collaboration, scope = f.scope();
    const request = service.update(scope, 'conversation', { operation: 'request', source: { eventId: 'request-origin', quote: '请把读书会记入本地。' }, title: '记录读书会', kind: 'action', expectedResult: '本地安排中有准确的读书会条目' });
    assert.equal(request.data.state, 'pending');
    assert.throws(() => service.finalize(scope, request, 'succeeded', 'fake-response', ['nonexistent-action']), /回执/);
    assert.throws(() => service.update(scope, 'conversation', { operation: 'progress', id: request.id, expectedRevision: request.revision, source: { eventId: 'request-origin', quote: '请把读书会记入本地。' }, status: 'succeeded' } as any));
    assert.equal(service.requests(scope, 'conversation')[0].data.state, 'pending');
    assert.throws(() => service.update(scope, 'conversation', { operation: 'request', source: { eventId: 'request-origin', quote: '我想每周跑步' }, title: '伪造承诺', kind: 'action', expectedResult: '不应建立' }), /原话/);
  } finally { f.close(); }
});

test('repair clears the superseded interpretation and cancels dependent unsubmitted actions', () => {
  const f = new Fixture();
  try {
    const scope = f.scope(), service = f.store.runtime.collaboration;
    f.ingest('请比较出门和留在住处。', 'frame-original');
    const frame = service.update(scope, 'conversation', {
      operation: 'frame', title: '地点选择', source: { eventId: 'frame-original', quote: '请比较出门和留在住处。' },
      frame: { question: '是否出门', confirmedFacts: [], decisions: [], tentativeUnderstanding: ['可能是担心距离'], participation: ['比较'], rejectedOptions: [], nextStep: '核查候选' },
    });
    const action = f.store.runtime.actions.prepare(scope, { capability: 'local.agenda.save', arguments: { title: '旧建议', detail: '待确认' }, dependencies: [{ consumerId: 'pending', producerId: frame.id, producerRevision: frame.revision, sensitivity: 'hard', invalidation: 'block' }] });
    f.ingest('不是距离，是重新开始很费劲。', 'frame-correction');
    const repaired = service.update(scope, 'conversation', { operation: 'repair', id: frame.id, expectedRevision: frame.revision, source: { eventId: 'frame-correction', quote: '不是距离，是重新开始很费劲。' }, reason: '改按切换成本重判' });
    assert.deepEqual(repaired.data.tentativeUnderstanding, []);
    assert.equal(repaired.status, 'needs_review');
    assert.equal(f.store.runtime.actions.get(scope, action.id)?.status, 'cancelled');
    assert.equal(f.store.agenda().length, 0);
  } finally { f.close(); }
});

test('natural privacy tool clears both forgotten content and the control quote that repeats it', async () => {
  const f = new Fixture();
  try {
    const memory = await f.remember('我的昵称是 CANARY_FORGET_TOOL_817。');
    const oldScope = f.scope();
    const text = '忘掉我的昵称 CANARY_FORGET_TOOL_817，以后别用了。';
    const run = f.store.runtime.begin(text, 'forget-request', 'forget-session', new AbortController().signal);
    await f.store.runtime.executeTool(run, 'apply_privacy_control', { operation: 'forget', ids: [memory.id], sourceQuote: text }, {
      ...callbacks, verifyPrivacyControl: async () => ({ approved: true, reason: 'Explicit host fixture; real language validation is separate.' }),
    });
    assert.equal(f.repo.searchEvidence(f.scope(), 'CANARY_FORGET_TOOL_817').length, 0);
    assert.ok(!JSON.stringify(f.store.export()).includes('CANARY_FORGET_TOOL_817'));
    assert.equal(run.privacyResult?.operation, 'forget');
    assert.throws(() => f.policy.validate(oldScope), /改变/);
  } finally { f.close(); }
});

test('source paging reports complete coverage and preserves Unicode and the final prohibition', async () => {
  const f = new Fixture();
  try {
    const text = '🧭合成背景。'.repeat(1500) + '末尾约束：不要提交。';
    const run = f.store.runtime.begin('读当前材料', 'page-query', 'page-session', new AbortController().signal, { attachment: { id: 'page-file', name: 'long.txt', text }, memoryMode: 'current_sources_only' });
    const parts = [];
    let offset = 0;
    do {
      const value: any = await f.store.runtime.executeTool(run, 'read_evidence', { id: 'page-file', offset, limit: 2500 }, callbacks);
      assert.equal(value.coverage.start, offset);
      assert.equal(Array.from(value.text).length, value.coverage.end - value.coverage.start);
      parts.push(value.text);
      offset = value.nextOffset;
    } while (offset !== null);
    assert.equal(parts.join(''), text);
    assert.ok(parts.at(-1)?.includes('不要提交'));
  } finally { f.close(); }
});

test('same-scope conversation carries all prior protocol turns in memory and source restriction clears them', async () => {
  const f = new Fixture(), requests: ModelWireMessage[][] = [];
  f.store.saveSettings({ mode: 'deepseek', memoryEnabled: true }); f.memory.paused = true;
  const harness = new Harness(f.store, () => 'isolated-test-key', () => {}, () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async messages => { requests.push(structuredClone(messages)); return { content: '回答 ' + requests.length, tool_calls: [] }; };
    client.assistantMessage = completion => ({ role: 'assistant', content: completion.content, reasoning_content: 'OPAQUE_PROTOCOL_' + completion.content });
    return withHostReplies(client);
  });
  try {
    const { sessionId } = harness.start(undefined, '第一轮只交流。'); await harness.idle();
    harness.start(sessionId, '继续第二轮。'); await harness.idle();
    assert.ok(requests[1].some(message => message.role === 'assistant' && message.content === '回答 1' && message.reasoning_content === 'OPAQUE_PROTOCOL_回答 1'));
    assert.ok(!JSON.stringify(f.store.export()).includes('OPAQUE_PROTOCOL_'));
    harness.start(sessionId, '现在只看本条。', { memoryMode: 'current_sources_only' }); await harness.idle();
    assert.ok(!JSON.stringify(requests[2]).includes('OPAQUE_PROTOCOL_'));
    assert.ok(!JSON.stringify(requests[2]).includes('第一轮只交流'));
    f.policy.revoke('campus:read');
    harness.start(sessionId, '在更新后的权限下继续。'); await harness.idle();
    assert.ok(!JSON.stringify(requests[3]).includes('OPAQUE_PROTOCOL_'));
  } finally { await harness.stop(); f.close(); }
});

test('independent original retrieval still ranks related passages while their index is missing', () => {
  const f = new Fixture();
  try {
    const left = f.ingest('旧摘要一：课程K原来在A101。'), right = f.ingest('旧摘要二：它来自相同旧通知。');
    f.ingest('完全无关的合成短文。');
    assert.equal(f.repo.db.prepare("SELECT count(*) AS n FROM h_grams WHERE kind='evidence'").get()!.n, 0);
    const rows = f.repo.lexicalEvidence(f.scope(), '旧摘要一 旧摘要二 教师通知');
    assert.ok(rows.some(row => row.id === left.id)); assert.ok(rows.some(row => row.id === right.id));
    assert.equal(f.repo.lexicalEvidence(f.scope({ sources: ['current'] }), '旧摘要一 旧摘要二').length, 0);
  } finally { f.close(); }
});

test('explicit local-only transmission blocks the control parser before text or attachments leave or persist', async () => {
  const f = new Fixture(); let calls = 0;
  f.store.saveSettings({ mode: 'deepseek' });
  const harness = new Harness(f.store, () => 'synthetic-key', () => {}, () => { calls++; throw new Error('Cloud factory must not run'); });
  try {
    harness.start(undefined, '任意自然话 CANARY_LOCAL_ONLY_842', { transmission: 'local_only', attachment: { id: 'local-file', name: 'local.txt', text: 'PRIVATE_ATTACHMENT_842' } });
    await harness.idle(); assert.equal(calls, 0);
    assert.ok(!JSON.stringify(f.store.export()).includes('CANARY_LOCAL_ONLY_842'));
    assert.ok(!JSON.stringify(f.store.export()).includes('PRIVATE_ATTACHMENT_842'));
  } finally { await harness.stop(); f.close(); }
});

test('temporary retention still permits verified protective deletion of existing data', async () => {
  const f = new Fixture();
  try {
    const memory = await f.remember('旧昵称 CANARY_TEMP_FORGET_843。');
    const text = '这轮不保存，忘掉旧昵称 CANARY_TEMP_FORGET_843。';
    const run = f.store.runtime.begin(text, 'temporary-forget', 'temporary-forget-session', new AbortController().signal, { retention: 'session_only' });
    assert.ok(f.store.runtime.toolSpecs(run).some(tool => tool.function.name === 'apply_privacy_control'));
    await f.store.runtime.executeTool(run, 'apply_privacy_control', { operation: 'forget', ids: [memory.id], sourceQuote: text }, { ...callbacks, verifyPrivacyControl: async () => ({ approved: true, reason: 'Explicit synthetic protective deletion.' }) });
    assert.ok(!JSON.stringify(f.store.export()).includes('CANARY_TEMP_FORGET_843'));
    assert.equal(f.repo.db.prepare("SELECT id FROM h_evidence WHERE id='temporary-forget'").get(), undefined);
  } finally { f.close(); }
});

test('action authorization uses current user evidence even when repeated, and never promotes assistant context', async () => {
  const current = { id: 'current', text: '把刚才那条撤掉。' };
  const history = [{ id: 'older-user', role: 'user', content: current.text }, { id: 'assistant', role: 'assistant', content: '之前已登记，随时可以撤销。' }];
  const complete: DeepSeekClient['complete'] = async () => ({ content: '', tool_calls: [{ id: 'verdict', type: 'function', function: { name: 'verify_local_delegation', arguments: JSON.stringify({ decision: 'execute_local', basis: [{ id: 'display-label', quote: current.text }, { id: 'assistant', quote: history[1].content }], missing: [], reason: 'Synthetic explicit user request and explanatory context.' }) } }] });
  const result = await checkLocalDelegation({ current, history, action: {}, now: '2026-09-14T06:00:00Z', timeZone: 'Asia/Shanghai' }, complete, new AbortController().signal);
  assert.deepEqual(result.basis, [{ id: 'current', quote: current.text }]);
  const assistantOnly: DeepSeekClient['complete'] = async () => ({ content: '', tool_calls: [{ id: 'verdict', type: 'function', function: { name: 'verify_local_delegation', arguments: JSON.stringify({ decision: 'execute_local', basis: [{ id: 'assistant', quote: history[1].content }], missing: [], reason: 'Invalid assistant-only authorization.' }) } }] });
  await assert.rejects(checkLocalDelegation({ current, history, action: {}, now: '2026-09-14T06:00:00Z', timeZone: 'Asia/Shanghai' }, assistantOnly, new AbortController().signal), /用户原话依据/);
});

test('hypothetical continuation can use this thread original context, while explicit current-only and other-person scopes cannot', async () => {
  const f = new Fixture();
  try {
    f.store.session('same-thread', '持续讨论');
    f.store.putMessage({ id: 'prior-self-context', sessionId: 'same-thread', role: 'user', content: '设备送修期间先暂停绘画，修好后再决定。', createdAt: f.clock.now(), status: 'done', steps: [], actions: [], obligations: [] });
    f.store.session('unrelated-thread', '无关');
    f.store.putMessage({ id: 'unrelated-private', sessionId: 'unrelated-thread', role: 'user', content: 'UNRELATED_PRIVATE_849', createdAt: f.clock.now(), status: 'done', steps: [], actions: [], obligations: [] });
    const semantic = controlProposal({ subject: 'none', world: 'hypothetical' });
    const run = f.store.runtime.begin('假设已经修好了，那个理由还成立吗？', 'hypo-current', 'same-thread', new AbortController().signal, { semantic });
    const pack = await f.store.runtime.compile(run);
    assert.ok(JSON.stringify(pack.data.history).includes('设备送修'));
    assert.ok(!JSON.stringify(pack).includes('UNRELATED_PRIVATE_849'));
    const restricted = f.store.runtime.begin('只看本条假设。', 'hypo-restricted', 'same-thread', new AbortController().signal, { semantic, memoryMode: 'current_sources_only' });
    assert.deepEqual((await f.store.runtime.compile(restricted)).data.history, []);
    const other = f.store.runtime.begin('替别人按假设比较。', 'hypo-other', 'same-thread', new AbortController().signal, { semantic: controlProposal({ subject: 'other', world: 'hypothetical' }) });
    assert.deepEqual((await f.store.runtime.compile(other)).data.history, []);
  } finally { f.close(); }
});

test('an image remains confined to its own turn and is not replayed by text conversation protocol caching', async () => {
  const f = new Fixture(), requests: ModelWireMessage[][] = [];
  f.store.saveSettings({ mode: 'deepseek', memoryEnabled: true }); f.memory.paused = true;
  const harness = new Harness(f.store, () => 'synthetic-key', () => {}, () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async messages => { requests.push(structuredClone(messages)); return { content: '本轮答复', tool_calls: [] }; };
    return withHostReplies(client);
  });
  try {
    const { sessionId } = harness.start(undefined, '处理当前图片', {}, { kind: 'image', name: 'test.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 });
    await harness.idle(); assert.ok(JSON.stringify(requests[0]).includes('image_url'));
    harness.start(sessionId, '现在只进行文字对话。'); await harness.idle();
    assert.ok(!JSON.stringify(requests[1]).includes('image_url'));
  } finally { await harness.stop(); f.close(); }
});

test('a temporary turn may cancel a verified prior local operation without saving its new message', async () => {
  const f = new Fixture();
  try {
    const runtime = f.store.runtime;
    const original = await runtime.actions.directLocal(f.scope(), { id: 'prior-event-cancel', capability: 'local.agenda.save', arguments: { title: '测试场次', detail: '', startsAt: '2026-09-15T11:20:00Z' }, authorized: true });
    const text = '那场不用留着了，请删掉刚记的这一条。';
    const run = runtime.begin(text, 'temporary-cancel-input', 'temporary-cancel', new AbortController().signal, { retention: 'session_only' });
    await runtime.executeTool(run, 'cancel_action', { id: original.action.id }, { ...callbacks, verifyLocalDelegation: async () => ({ decision: 'execute_local', basis: [{ id: 'temporary-cancel-input', quote: text }], missing: [], reason: 'Synthetic explicit cancellation.' }) });
    assert.equal(f.store.agenda().length, 0);
    assert.equal(f.repo.db.prepare("SELECT id FROM h_evidence WHERE id='temporary-cancel-input'").get(), undefined);
  } finally { f.close(); }
});

test('worker source scope is explicit, minimal and cannot be enlarged past the root boundary', () => {
  const f = new Fixture();
  try {
    f.ingest('PRIVATE_WORKER_DEFAULT_CANARY');
    const run = f.store.runtime.begin('只研究给定方向。', 'root-current', 'root', new AbortController().signal);
    const empty = f.store.runtime.childScope(run, { title: '只计算', instruction: '计算2+3。' });
    assert.deepEqual(f.policy.validate(empty).sources, ['current']);
    assert.deepEqual(f.policy.validate(empty).currentEventIds, []);
    assert.equal(f.repo.searchEvidence(empty, 'PRIVATE_WORKER_DEFAULT_CANARY').length, 0);
    assert.throws(() => f.store.runtime.childScope(run, { title: '越界', instruction: '不应扩大。', sources: ['never-authorized'] }), /扩大/);
    const bounded = f.store.runtime.childScope(run, { title: '当前片段', instruction: '只读父任务指定的本轮原话。', sources: ['current'], currentEvidenceIds: ['root-current'] });
    assert.equal(f.repo.evidence(bounded, 'root-current')?.text, run.ingress.authoredText);
    assert.equal(f.repo.searchEvidence(bounded, 'PRIVATE_WORKER_DEFAULT_CANARY').length, 0);
    assert.throws(() => f.store.runtime.childScope(run, { title: '伪引用', instruction: '不应扩大。', currentEvidenceIds: ['old-other-event'] }), /扩大/);
  } finally { f.close(); }
});

test('a worker instruction cannot authorize private reads that the root user did not request', async () => {
  const f = new Fixture(); let privateReads = 0, parentCalls = 0, purposeChecks = 0;
  const original = '只核对我提供的公开名称，不查任何私人内容。';
  f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true;
  f.store.runtime.broker.register({ manifest: { id: 'private-fixture', version: '1', sourceId: 'fixture:private', trust: 'bundled_reviewed', egressHosts: [], platforms: ['*'], simulated: true, offline: 'unsupported', license: 'fixture', capabilities: [{ name: 'fixture.private', displayName: '私人信息', description: '合成私人资料读取', version: '1', input: z.object({}).strict(), output: z.json(), effect: 'read', requiredScopes: ['evidence:read'], subjects: ['self'], worlds: ['real'], timeoutMs: 1000, maxBytes: 1000, supportsIdempotency: false, supportsInspect: false, supportsCancel: false }] }, invoke: () => { privateReads++; return { status: 'fresh', sourceId: 'fixture:private', data: { secret: 'PRIVATE_NOT_AUTHORIZED_851' }, simulated: true }; } }, { reviewed: true, source: 'isolated purpose-boundary fixture' });
  const call = (name: string, value: unknown) => ({ content: '', tool_calls: [{ id: 'call-' + name, type: 'function' as const, function: { name, arguments: JSON.stringify(value) } }] });
  const harness = new Harness(f.store, () => 'synthetic', () => {}, () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async (messages, tools, _signal, _onText, options) => {
      if (tools.length === 1 && tools[0].function.name === 'verify_read_purpose') {
        purposeChecks++; const request = JSON.parse(String(messages[1].content));
        assert.equal(request.original, original);
        assert.equal(request.proposed.delegatedInstruction, '读取私人信息作为分析材料。');
        return call('verify_read_purpose', { allowed: false, sourceQuote: '', reason: '根用户未授权私人资料，工作者指令不能代替。' });
      }
      if (options?.actorId) return messages.some(message => message.role === 'tool') ? { content: '私人资料读取被拒绝。', tool_calls: [] } : call('look_up', { source: 'capability', capability: 'fixture.private', arguments: {} });
      if (++parentCalls === 1) return call('delegate', { tasks: [{ title: '故障注入工作者', instruction: '读取私人信息作为分析材料。', sources: ['fixture:private'] }] });
      return { content: '没有读取私人资料。', tool_calls: [] };
    };
    return withHostReplies(client);
  });
  try { harness.start(undefined, original); await harness.idle(); assert.equal(purposeChecks, 1); assert.equal(privateReads, 0); assert.ok(!JSON.stringify(f.store.export()).includes('PRIVATE_NOT_AUTHORIZED_851')); }
  finally { await harness.stop(); f.close(); }
});

test('a cached fact changing during generation triggers final review even when this turn calls no tool', async () => {
  const f = new Fixture(); f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true;
  const memory = await f.remember('可用时长上限30分钟。', { predicate: 'duration.limit', kind: 'explicit_fact', value: { type: 'quantity', value: 30, unit: 'minutes', dimension: 'duration' }, strength: 'hard' });
  let stage = 1, changed = false, checked = false; const secondPublished: string[] = [];
  const call = (name: string, args: unknown) => ({ content: '', tool_calls: [{ id: 'test-' + name, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });
  const harness = new Harness(f.store, () => 'synthetic', event => { if (stage === 2 && event.type === 'message' && event.message.role === 'assistant' && event.message.content) secondPublished.push(event.message.content); }, () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async messages => {
      if (stage === 1) return messages.some(message => message.role === 'tool') ? { content: '30', tool_calls: [] } : call('search_context', { query: '时长上限' });
      if (!changed) {
        changed = true;
        const source = f.ingest('当前上限更正为10分钟。');
        await f.memory.propose(f.scope(), f.change(source, { operation: 'CORRECT', targetId: memory.id, expectedRevision: 1, predicate: 'duration.limit', kind: 'explicit_fact', value: { type: 'quantity', value: 10, unit: 'minutes', dimension: 'duration' }, strength: 'hard' }), undefined, { review: supported });
        return { content: '30', tool_calls: [] };
      }
      return { content: '10', tool_calls: [] };
    };
    const wrapped = withHostReplies(client), forward = wrapped.complete.bind(wrapped);
    wrapped.complete = async (...args) => {
      if (args[1].length === 1 && args[1][0].function.name === 'report_completion_gaps') {
        const input = JSON.parse(String(args[0][1].content));
        if (stage === 2 && input.reply === '30') { checked = true; assert.ok(input.observations.some((item: any) => item.tool === 'host_state_change')); }
        return call('report_completion_gaps', { missing: [], contradictions: stage === 2 && input.reply === '30' ? ['依据已变成10分钟，尚未发布的30分钟答复需要重判。'] : [], requests: [] });
      }
      return forward(...args);
    };
    return wrapped;
  });
  try {
    const { sessionId } = harness.start(undefined, '查一下时长上限。'); await harness.idle();
    stage = 2; harness.start(sessionId, '再直接告诉我当前上限。'); await harness.idle();
    assert.equal(checked, true, JSON.stringify({ changed, secondPublished, observations: f.store.runtime.lastSession?.observations })); assert.ok(secondPublished.length); assert.ok(secondPublished.every(text => text === '10'));
  } finally { await harness.stop(); f.close(); }
});
