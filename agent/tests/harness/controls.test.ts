import test from 'node:test';
import assert from 'node:assert/strict';
import { Fixture, withHostReplies } from './support';
import { NativeControls } from '../../src/main/runtime/controls';
import { Harness } from '../../src/main/harness';
import { DeepSeekClient } from '../../src/main/provider';

test('native memory, evidence, coverage and goal decisions share durable versions', async () => {
  const f = new Fixture();
  try {
    const control = new NativeControls(f.store, { running: false, recoverPending: async () => {} }),
      memory = f.memory.saveControl('我喜欢步行');
    assert.equal(control.overview().memories[0].revision, 1);
    assert.equal(control.evidence(memory.evidenceIds[0])?.text, '我喜欢步行');
    const goal = f.store.runtime.work.create(f.scope(), 'goal', '准备下周演示', {}, { status: 'proposed' });
    control.goal({ id: goal.id, expectedRevision: 1, status: 'active' });
    assert.throws(() => control.goal({ id: goal.id, expectedRevision: 1, status: 'cancelled' }), /已有变化/);
    control.goal({ id: goal.id, expectedRevision: 2, status: 'cancelled' });
    assert.equal(control.overview().work.find((w) => w.id === goal.id)?.status, 'cancelled');
    f.memory.forget([memory.id]);
    assert.equal(control.evidence(memory.evidenceIds[0])?.status, 'redacted');
    assert.ok(!JSON.stringify(control.evidence(memory.evidenceIds[0])).includes('我喜欢步行'));
  } finally {
    f.close();
  }
});
test('feedback records explicit reason without manufacturing outcome or causal success', () => {
  const f = new Fixture();
  try {
    const control = new NativeControls(f.store, { running: false, recoverPending: async () => {} }),
      a = f.store.runtime.actions.prepare(f.scope(), {
        capability: 'local.agenda.save',
        arguments: { title: '整理草稿', detail: '准备建议' },
      });
    assert.throws(() => control.feedback({ recommendationId: 'invented', response: 'accepted' }), /不存在/);
    assert.deepEqual(
      control.feedback({ recommendationId: a.id, response: 'declined', reason: '今天希望留空' }),
      { saved: true, causalSuccess: 'not_established' },
    );
    const observations = f.store.runtime.observations.list(f.scope(), 'feedback');
    assert.equal(observations[0].data.explicitReason, '今天希望留空');
    assert.equal(
      f.store.runtime.observations.feedbackProjection(f.scope(), observations[0].id).outcome,
      'not_observed',
    );
  } finally {
    f.close();
  }
});
test('native revoke invalidates old scope immediately, retry requires connected inference', async () => {
  const f = new Fixture();
  try {
    const control = new NativeControls(f.store, { running: false, recoverPending: async () => {} }),
      scope = f.scope();
    control.permission({ scope: 'campus:read', enabled: false });
    assert.throws(() => f.policy.validate(scope), /已改变/);
    assert.ok(control.overview().revoked.includes('campus:read'));
    control.permission({ scope: 'campus:read', enabled: true });
    assert.ok(!control.overview().revoked.includes('campus:read'));
    await assert.rejects(control.retry('unused'), /连接 DeepSeek/);
    assert.equal(control.overview().storage.atRestEncrypted, false);
  } finally {
    f.close();
  }
});
test('replaying a completed privacy fence preserves later independent conversation, action card and draft', () => {
  let f = new Fixture();
  try {
    const sid = f.store.session(undefined, '测试会话'),
      old = f.memory.saveControl('我喜欢步行');
    const base = {
      sessionId: sid,
      createdAt: f.clock.now(),
      status: 'done' as const,
      steps: [],
      obligations: [],
      actions: [],
    };
    f.store.putMessage({ ...base, id: old.evidenceIds[0], role: 'user', content: '我喜欢步行' });
    f.store.putMessage({ ...base, id: 'old-answer', role: 'assistant', content: '旧的建议' });
    f.memory.forget([old.id]);
    f.store.putMessage({
      ...base,
      id: 'new-answer',
      role: 'assistant',
      content: '重新核对后的独立建议',
      actions: [{ id: 'new-card', title: '新安排', detail: '新的来源' }],
    });
    f.store.putMeta('draft:' + sid, { text: '删除之后的新草稿', attachment: null });
    f = f.restart();
    assert.equal(f.store.messages(sid).find((m) => m.id === 'new-answer')?.actions[0].id, 'new-card');
    assert.equal(f.store.meta<any>('draft:' + sid, null).text, '删除之后的新草稿');
    assert.ok(!f.memory.views().some((m) => m.id === old.id));
  } finally {
    f.close();
  }
});
test('temporary Windows rename contention preserves and eventually advances an atomic privacy barrier', () => {
  const f = new Fixture();
  try {
    let attempts = 0;
    f.repo.fault = (point) => {
      if (point === 'before_privacy_rename' && ++attempts < 3)
        throw Object.assign(new Error('synthetic sharing violation'), { code: 'EPERM' });
    };
    const epoch = f.repo.epoch;
    f.policy.revoke('campus:read');
    assert.equal(f.repo.epoch, epoch + 1);
    assert.ok(attempts >= 3);
    f.repo.fault = undefined;
    f.policy.revoke('campus:read');
    assert.equal(f.repo.epoch, epoch + 1);
  } finally {
    f.close();
  }
});
test('native hypothetical adoption reviews exact scope, creates preparation once and never changes real facts', () => {
  const f = new Fixture();
  try {
    const controls = new NativeControls(f.store, { running: false, recoverPending: async () => {} }),
      r = f.store.runtime;
    r.work.createWorld(f.scope(), 'ui-world', { portfolio: '准备一页作品集' });
    const diff = controls.overview().worlds[0],
      input = {
        id: diff.worldId,
        itemIds: [diff.items[0].id],
        expectedBaseRevision: diff.baseRevision,
        expectedPrivacyEpoch: f.repo.epoch,
      };
    controls.adoptWorld(input);
    controls.adoptWorld(input);
    const tasks = f.repo.work(f.scope(), 'task');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'draft');
    assert.equal(f.repo.work(f.scope(), 'commitment').length, 0);
    assert.equal(f.repo.assertions(f.scope()).length, 0);
    f.policy.revoke('campus:read');
    assert.throws(() => controls.adoptWorld(input), /范围已经变化/);
  } finally {
    f.close();
  }
});
test('original Harness keeps stable option references when the model explicitly restores and resolves the next turn', async () => {
  const f = new Fixture();
  let phase = 0;
  f.store.saveSettings({ mode: 'deepseek' });
  f.memory.paused = true;
  const harness = new Harness(f.store, () => 'synthetic', () => {}, () => {
    const client = new DeepSeekClient('synthetic', 'deepseek-flash');
    client.complete = async (messages) => {
      const call = (name: string, args: unknown) => ({ content: '', tool_calls: [{ id: 'phase-' + phase, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });
      if (phase++ === 0) return call('update_work_state', { operation: 'propose_options', options: [{ title: '先散步', rationale: '休息' }, { title: '先读书', rationale: '安静坐一会儿' }] });
      if (phase === 2) return { content: '两个选项：先散步，或者先读书。', tool_calls: [] };
      if (phase === 3) return call('restore_collaboration', {});
      if (phase === 4) {
        const observation = JSON.parse(String(messages.filter(m => m.role === 'tool').at(-1)?.content));
        const episode = observation.items.find((item: any) => item.kind === 'episode');
        return call('update_work_state', { operation: 'reference_option', episodeId: episode.id, expectedRevision: episode.revision, id: episode.data.anchorOrder[1], sourceQuote: '选第二个' });
      }
      return { content: '继续讨论先读书这个选项；还没有登记安排。', tool_calls: [] };
    };
    return withHostReplies(client);
  });
  try {
    const { sessionId } = harness.start(undefined, '给我两个下一步选项');
    await harness.idle();
    assert.equal(f.repo.work(f.scope(), 'option').length, 2);
    const episode = f.repo.work(f.scope(), 'episode')[0], second = (episode.data.anchorOrder as string[])[1];
    harness.start(sessionId, '选第二个');
    await harness.idle();
    assert.equal(f.repo.work(f.scope(), 'episode')[0].data.referencedOptionId, second);
    assert.ok((f.store.runtime.lastSession?.pack?.data.workState as any[]).some(w => w.id === second));
  } finally { await harness.stop(); f.close(); }
});

test('correcting a bound reality source marks its hypothetical branch stale before adoption', () => {
  const f = new Fixture();
  try {
    const m = f.memory.saveControl('我喜欢步行。');
    f.store.runtime.work.createWorld(f.scope(), 'source-bound', { move: '准备搬家' });
    f.memory.saveControl('我更喜欢骑车。', m.id, { expectedRevision: 1 });
    assert.equal(f.store.runtime.work.adoptionDiff(f.scope(), 'source-bound').status, 'stale');
    assert.throws(
      () => f.store.runtime.work.adoptPreparation(f.scope(), 'source-bound', ['source-bound:move']),
      /现实条件已变/,
    );
  } finally {
    f.close();
  }
});
test('ready map route keeps verified provider status and emits the existing route-card shape', async () => {
  const f = new Fixture();
  try {
    f.store.runtime.connect({
      map: {
        route: () => ({ status: 'ready', distance_m: 206 }),
        overview: () => ({ version: 'synthetic-status-contract' }),
        search: () => [],
        locationStatus: () => ({ status: 'unknown' }),
      } as any,
    });
    const run = f.store.runtime.begin('地图路线', 'map-turn', 'map-session', new AbortController().signal);
    let card: any;
    const result: any = await f.store.runtime.executeTool(
      run,
      'map_route',
      {},
      {
        step: () => {},
        plan: () => {},
        action: () => {},
        changed: () => {},
        mapCard: (c) => {
          card = c;
        },
        delegate: async () => [],
      },
    );
    assert.equal(result.status, 'fresh');
    assert.equal(card.kind, 'route');
    assert.equal(card.route.status, 'ready');
  } finally {
    f.close();
  }
});
test('deleting unextracted history clears cross-session reply, action and option derivatives while preserving unrelated evidence', async () => {
  const f = new Fixture(),
    secret = 'CROSS_SESSION_RAW_739',
    source = f.ingest('主图学习的原文记录：' + secret),
    unrelated = f.ingest('我喜欢梨。');
  let turn = 0;
  f.store.saveSettings({ mode: 'deepseek' });
  const harness = new Harness(
    f.store,
    () => '',
    () => {},
    () => {
      const client = new DeepSeekClient('synthetic', 'deepseek-flash');
      client.complete = async (messages) => {
        if (messages[0].content?.includes('[harness:extract'))
          return { content: JSON.stringify({ status: 'no_personal_fact', changes: [] }), tool_calls: [] };
        const calls = [
          { name: 'search_context', args: { query: '主图学习' } },
          { name: 'prepare_action', args: { title: '主图整理', detail: secret } },
          {
            name: 'update_work_state',
            args: {
              operation: 'propose_options',
              options: [
                { title: '主图学习 ' + secret, rationale: secret },
                { title: '先休息', rationale: '保留空闲' },
              ],
            },
          },
          {
            name: 'update_work_state',
            args: { operation: 'propose_goal', title: '主图目标 ' + secret, reason: secret },
          },
        ];
        const call = calls[turn++];
        return call
          ? {
              content: '',
              tool_calls: [
                {
                  id: 'derived-' + turn,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                },
              ],
            }
          : { content: secret, tool_calls: [] };
      };
      return withHostReplies(client);
    },
  );
  try {
    const { sessionId } = harness.start(undefined, '根据主图学习的原文记录，给我下一步建议');
    await harness.idle();
    const output = f.store.messages(sessionId).find((m) => m.role === 'assistant')!;
    assert.ok(output.contextReceipt?.providedEvidenceIds.includes(source.id));
    assert.ok(output.actions.length);
    assert.ok(output.content.includes(secret));
    f.store.putMessage({ ...output, releaseArtifacts: [{ id: 'derived-draft', body: secret, sourceMessageId: source.id, sourceMessageIds: [source.id] }], futureSemanticExtension: { text: secret }, image: { dataUrl: secret } } as any);
    f.memory.forget([source.id]);
    assert.ok(!JSON.stringify(f.store.messages(sessionId)).includes(secret));
    assert.ok(!JSON.stringify(f.store.runtime.actions.list(f.scope())).includes(secret));
    assert.ok(!JSON.stringify(f.repo.work(f.scope())).includes(secret));
    assert.equal(f.repo.evidence(f.scope(), unrelated.id)?.text, '我喜欢梨。');
  } finally {
    await harness.stop();
    f.close();
  }
});
