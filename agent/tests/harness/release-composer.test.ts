import test from 'node:test';
import assert from 'node:assert/strict';
import { Fixture, controlProposal } from './support';
import { Harness } from '../../src/main/harness';
import { DeepSeekClient } from '../../src/main/provider';
import { composeRelease } from '../../src/main/runtime/release-composer';
import { readReleaseArtifacts } from '../../src/main/runtime/release-store';
import type { Message } from '../../src/shared/types';

const tool = (name: string, args: unknown) => ({ id: 'fixture-' + name, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
const brief = { recipient: '组织者', purpose: '说明不能参加', allowedFacts: ['当天另有安排，不能参加'], tone: '自然', useAvailability: false, requestedOperation: 'draft' as const, referencePrevious: false, reusePriorDraft: false };

test('one owner completes a local action and isolated draft, then revises only the actual draft version', async () => {
  const f = new Fixture(); f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true;
  let latest: Message | undefined, stage = 1, mainCalls = 0, writes = 0, writerReviews = 0, artifactId = '';
  const original = '明天下午三点做本地材料复核，记下来。另外给组织者写我当天有事不能参加。私下原因CANARY_OWNER_941不能写给他。';
  const bodies = ['您好，我当天另有安排，无法参加。', '您好，很遗憾当天另有安排，无法参加。感谢理解。'];
  const factory = () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async (messages, tools, _signal, _text, options) => {
      const name = tools.length === 1 ? tools[0].function.name : '';
      if (name === 'propose_turn_controls') {
        const { sources: _, ...proposal } = controlProposal({ audience: 'group', actions: 'draft_only', actionsApplyToWholeTurn: false, release: { ...brief, referencePrevious: stage === 2, reusePriorDraft: stage === 2 } });
        return { content: '', tool_calls: [tool(name, proposal)] };
      }
      if (name === 'project_release_brief') {
        const input = JSON.parse(String(messages[1].content));
        if (stage === 1) assert.ok(input.original.includes('CANARY_OWNER_941'));
        else { assert.equal(input.priorReleasedDraft.text, bodies[0]); assert.ok(!JSON.stringify(input.priorReleasedDraft).includes('CANARY_OWNER_ANALYSIS')); }
        f.store.runtime.lastSession!.dependencyNotices = [{ note: 'CANARY_PRIVATE_NOTICE_942' }];
        return { content: '', tool_calls: [tool(name, { ...brief, referencePrevious: stage === 2, reusePriorDraft: stage === 2 })] };
      }
      if (name === 'verify_local_delegation') {
        const input = JSON.parse(String(messages[1].content));
        return { content: '', tool_calls: [tool(name, { decision: 'execute_local', basis: [{ id: input.current.id, quote: input.current.text }], missing: [], reason: 'Synthetic explicit local delegation.' })] };
      }
      if (options?.phase === 'release_write') {
        writes++; assert.ok(!JSON.stringify(messages).includes('CANARY_')); assert.ok(!JSON.stringify(messages).includes('本地材料复核'));
        assert.deepEqual(tools, []); assert.equal(options.thinking, 'enabled');
        return { content: bodies[stage - 1], tool_calls: [] };
      }
      if (name === 'report_completion_gaps') {
        if (options?.phase === 'release_review') { writerReviews++; assert.ok(!JSON.stringify(messages).includes('CANARY_')); }
        return { content: '', tool_calls: [tool(name, { missing: [], contradictions: [], requests: [] })] };
      }
      assert.equal(options?.phase, 'main');
      if (++mainCalls === 1) return { content: '', tool_calls: [
        ...(stage === 1 ? [tool('prepare_action', { title: '本地材料复核', detail: '', startsAt: '2026-09-15T15:00:00+08:00' })] : []),
        tool('prepare_release', { sourceQuote: stage === 1 ? original : '把刚才那份稿件改得温和一点。', task: stage === 1 ? '给组织者起草不能参加的通知。' : '温和一点，保留原意。', ...(stage === 2 ? { priorArtifactId: artifactId } : {}) }),
      ] };
      return { content: '私下说明CANARY_OWNER_ANALYSIS。需要的事项已处理，稿件见下方。', tool_calls: [] };
    };
    return client;
  };
  const harness = new Harness(f.store, () => 'synthetic', event => { if (event.type === 'message' && event.message.role === 'assistant') latest = structuredClone(event.message); }, factory);
  try {
    const { sessionId } = harness.start(undefined, original); await harness.idle();
    assert.equal(latest?.status, 'done', latest?.content || 'No response'); assert.equal(f.store.agenda().length, 1);
    assert.equal(f.store.agenda()[0].durationMinutes, undefined);
    assert.equal(latest?.releaseArtifacts?.length, 1); const first = latest!.releaseArtifacts![0]; artifactId = first.id;
    assert.equal(first.body, bodies[0]); assert.equal(first.revision, 1); assert.equal(first.delivery, 'not_sent');
    assert.ok(latest!.content.includes('> ' + bodies[0])); assert.ok(!JSON.stringify(first).includes('CANARY_'));
    stage = 2; mainCalls = 0;
    harness.start(sessionId, '把刚才那份稿件改得温和一点。'); await harness.idle();
    assert.equal(latest?.status, 'done', latest?.content || 'No response'); const second = latest!.releaseArtifacts![0];
    assert.equal(second.id, first.id); assert.equal(second.revision, 2); assert.equal(second.body, bodies[1]);
    assert.deepEqual(second.supersedes, { id: first.id, revision: 1 });
    assert.equal(writes, 2); assert.equal(writerReviews, 2); assert.equal(f.store.agenda().length, 1);
  } finally { await harness.stop(); f.close(); }
});

test('a cancelled isolated writer cannot return a late artifact', async () => {
  const controller = new AbortController(); let release!: (value: any) => void;
  const pending = composeRelease({ brief, audience: 'group', now: '2026-09-14T06:00:00Z', timeZone: 'Asia/Shanghai', messageId: 'current', epoch: 1,
    signal: controller.signal, validate: () => controller.signal.throwIfAborted(), complete: async () => new Promise(resolve => { release = resolve; }),
  });
  controller.abort(new DOMException('writer_cancelled', 'AbortError'));
  release({ content: 'Late content', tool_calls: [] });
  await assert.rejects(pending, /writer_cancelled/);
});

test('owner mode keeps explicit UI source and audience limits', async () => {
  const f = new Fixture();
  try {
    const run = f.store.runtime.begin('给别人起草，只用当前内容。', 'owner-explicit-ui', 'owner-ui', new AbortController().signal, { replyToOwner: true, audience: 'group', memoryMode: 'current_sources_only', semantic: controlProposal({ audience: 'group', release: brief }) });
    const scope = f.policy.validate(run.ingress.contract.scope);
    assert.equal(scope.audience, 'group'); assert.deepEqual(scope.sources, ['current']);
    assert.ok(!scope.grants.includes('action:execute')); assert.ok(!scope.grants.includes('local:write'));
    assert.ok(f.store.runtime.generationInput(run).includes('只用当前内容'));
  } finally { f.close(); }
});

test('draft completion is distinct from action execution, and action explanations remain unfulfilled without receipts', () => {
  const f = new Fixture();
  try {
    const scope = f.scope(), source = f.ingest('请给组织者起草一段说明。');
    const service = f.store.runtime.collaboration;
    const request = service.update(scope, 'typed-result', { operation: 'request', kind: 'action', title: '起草说明', expectedResult: '一份可交付的草稿', source: { eventId: source.id, quote: source.text } });
    const artifact = { id: 'actual-artifact', revision: 1, body: '合成草稿', createdAt: f.clock.now(), sourceMessageId: source.id, privacyEpoch: f.repo.epoch, audience: 'group' as const, brief, delivery: 'not_sent' as const };
    const finished = service.finalize(scope, request, 'answered', 'response', [], { kind: 'artifact', basisQuote: source.text, artifactIds: [artifact.id], artifacts: [artifact] });
    assert.equal(finished.data.requestKind, 'artifact'); assert.equal(finished.data.state, 'answered');
    assert.ok((finished.data.resultRefs as string[]).includes('artifact:actual-artifact@1'));
    const sendSource = f.ingest('请把这封邮件发出去。');
    const action = service.update(scope, 'typed-result', { operation: 'request', kind: 'action', title: '发送邮件', expectedResult: '真实投递回执', source: { eventId: sendSource.id, quote: sendSource.text } });
    assert.throws(() => service.finalize(scope, action, 'succeeded', 'wrong', [artifact.id], { artifacts: [artifact] }), /回执/);
    assert.throws(() => service.finalize(scope, action, 'answered', 'wrong', [], { kind: 'artifact', basisQuote: sendSource.text, artifactIds: [artifact.id], artifacts: [artifact] }), /成稿/);
    const explained = service.finalize(scope, action, 'answered', 'not-connected', []);
    assert.equal(explained.data.state, 'unfulfilled'); assert.equal(explained.data.requestKind, 'action');
    assert.equal(f.store.agenda().length, 0);
  } finally { f.close(); }
});

test('availability projection computes safe windows and preserves limited coverage when the local calendar is empty', async () => {
  const f = new Fixture();
  try {
    const run = f.store.runtime.begin('只分享明天上午可约时段。', 'empty-availability', 'availability', new AbortController().signal, { replyToOwner: true, semantic: controlProposal({ release: { ...brief, useAvailability: true } }) });
    const result: any = await f.store.runtime.executeTool(run, 'availability_projection', { from: '2026-09-15T00:00:00Z', to: '2026-09-15T04:00:00Z' }, { step() {}, plan() {}, action() {}, changed() {}, delegate: async () => [] });
    assert.equal(result.status, 'known_absent'); assert.equal(result.coverage.externalCoverageConfirmed, false);
    assert.deepEqual(result.availableWindows, [{ start: '2026-09-15T00:00:00.000Z', end: '2026-09-15T04:00:00.000Z' }]);
  } finally { f.close(); }
});

test('a cancelled imported event does not consume availability and its private title never enters the projection', async () => {
  const f = new Fixture();
  try {
    f.store.runtime.domains.importSnapshot({ source: 'synthetic schedule', updatedAt: f.clock.now(), schedule: [
      { id: 'cancelled-class', title: 'CANARY_CANCELLED_TITLE', startsAt: '2026-09-15T01:00:00Z', endsAt: '2026-09-15T02:00:00Z', status: 'cancelled', source: 'synthetic', location: '' },
      { id: 'active-class', title: 'CANARY_ACTIVE_TITLE', startsAt: '2026-09-15T02:00:00Z', endsAt: '2026-09-15T03:00:00Z', status: 'scheduled', source: 'synthetic', location: '' },
    ], exams: [], places: [], rules: [] });
    const run = f.store.runtime.begin('核对明天上午的忙闲。', 'cancelled-projection', 'availability', new AbortController().signal, { replyToOwner: true, semantic: controlProposal({ release: { ...brief, useAvailability: true } }) });
    const result: any = await f.store.runtime.executeTool(run, 'availability_projection', { from: '2026-09-15T00:00:00Z', to: '2026-09-15T04:00:00Z' }, { step() {}, plan() {}, action() {}, changed() {}, delegate: async () => [] });
    assert.deepEqual(result.availableWindows, [{ start: '2026-09-15T00:00:00.000Z', end: '2026-09-15T02:00:00.000Z' }, { start: '2026-09-15T03:00:00.000Z', end: '2026-09-15T04:00:00.000Z' }]);
    assert.ok(!JSON.stringify(result).includes('CANARY_'));
  } finally { f.close(); }
});

test('explicit outward UI delivers only the isolated artifact, while the raw preparation stays private', async () => {
  const f = new Fixture(); f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true;
  let latest: Message | undefined, mains = 0;
  const original = 'CANARY_UI_PRIVATE_955。给组织者起草一句不能参加，不写私人原因。';
  const harness = new Harness(f.store, () => 'synthetic', event => { if (event.type === 'message' && event.message.role === 'assistant') latest = structuredClone(event.message); }, () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async (_messages, tools, _signal, _onText, options) => {
      const name = tools.length === 1 ? tools[0].function.name : '';
      if (name === 'propose_turn_controls') { const { sources: _, ...proposal } = controlProposal({ audience: 'group', release: brief }); return { content: '', tool_calls: [tool(name, proposal)] }; }
      if (name === 'project_release_brief') return { content: '', tool_calls: [tool(name, brief)] };
      if (name === 'report_completion_gaps') return { content: '', tool_calls: [tool(name, { missing: [], contradictions: [], requests: [] })] };
      if (options?.phase === 'release_write') return { content: '您好，我当天另有安排，无法参加。', tool_calls: [] };
      if (++mains === 1) return { content: '', tool_calls: [tool('prepare_release', { sourceQuote: original, task: '给组织者起草不能参加的消息。' })] };
      return { content: 'CANARY_UI_PRIVATE_955 以及 CANARY_OWNER_COMMENT_956 只应留在私人准备里。', tool_calls: [] };
    };
    return client;
  });
  try {
    harness.start(undefined, original, { audience: 'group', memoryMode: 'current_sources_only' }); await harness.idle();
    assert.equal(latest?.status, 'done', latest?.content || 'No reply');
    assert.ok(!latest!.content.includes('CANARY_')); assert.ok(!latest!.responseText?.includes('CANARY_'));
    assert.equal(latest!.releaseArtifacts?.length, 1);
    const origin = f.repo.db.prepare("SELECT audience FROM h_evidence WHERE content LIKE '%CANARY_UI_PRIVATE_955%'").get();
    assert.equal(origin?.audience, 'self');
    assert.equal(f.store.agenda().length, 0);
  } finally { await harness.stop(); f.close(); }
});

test('draft reads filter sources, ownership and epochs before returning bodies, without loading owner response prose', async () => {
  const f = new Fixture();
  try {
    const run = f.store.runtime.begin('起草一份测试消息。', 'scoped-draft-origin', 'scoped-draft-session', new AbortController().signal);
    const pack = await f.store.runtime.compile(run);
    const artifact = { id: 'scoped-draft', revision: 1, body: 'APPROVED_DRAFT_TEXT', createdAt: f.clock.now(), sourceMessageId: run.events[0].id, privacyEpoch: f.repo.epoch, audience: 'group' as const, brief, delivery: 'not_sent' as const, ownerId: f.repo.identity.principalId, workspaceId: f.repo.identity.workspaceId, sourceIds: ['history:self', 'campus:local'] };
    f.store.session(run.sessionId, 'draft scope');
    f.store.putMessage({ id: 'scoped-draft-response', sessionId: run.sessionId, role: 'assistant', content: 'CANARY_OWNER_RESPONSE_NOT_A_DRAFT', responseText: 'CANARY_OWNER_RESPONSE_NOT_A_DRAFT', createdAt: f.clock.now(), status: 'done', steps: [], actions: [], obligations: [], releaseArtifacts: [artifact, { ...artifact, id: 'foreign-draft', ownerId: 'different-owner' }], contextReceipt: pack.receipt });
    const permitted = readReleaseArtifacts(f.repo, f.policy, f.scope(), run.sessionId);
    assert.equal(permitted.length, 1); assert.equal(permitted[0].body, artifact.body);
    assert.ok(!JSON.stringify(permitted).includes('CANARY_OWNER_RESPONSE'));
    let before = f.repo.access.length;
    assert.deepEqual(readReleaseArtifacts(f.repo, f.policy, f.scope({ sources: ['current', 'history:self'] }), run.sessionId), []);
    assert.equal(f.repo.access.length, before);
    assert.deepEqual(readReleaseArtifacts(f.repo, f.policy, f.scope(), run.sessionId, 'foreign-draft'), []);
    assert.equal(f.repo.access.length, before);
    f.policy.revoke('memory:write'); before = f.repo.access.length;
    assert.ok(f.repo.db.prepare('SELECT id FROM messages WHERE id=?').get('scoped-draft-response'));
    assert.deepEqual(readReleaseArtifacts(f.repo, f.policy, f.scope(), run.sessionId), []);
    assert.equal(f.repo.access.length, before);
  } finally { f.close(); }
});
