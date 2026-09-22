import test from 'node:test';
import assert from 'node:assert/strict';
import { Fixture, controlProposal } from './support';

test('ReleaseSpec preserves audience intent while public serialization excludes the authored private reason', async () => {
  const f = new Fixture();
  try {
    const run = f.store.runtime.begin(
      '我有CANARY_PRIVATE_REASON_421。给老师写一段，沟通目的：申请延期，因为家庭原因；公开内容：周三下午、目前可以提交；语气：礼貌自然；先别发送。',
      'release-turn',
      'release-session',
      new AbortController().signal,
      { semantic: controlProposal({ audience: 'group', release: { recipient: '老师', purpose: '申请延期', allowedFacts: ['周三下午', '目前可以提交'], tone: '礼貌自然', useAvailability: false } }) },
    );
    const pack = await f.store.runtime.compile(run);
    const spec = pack.data.releaseSpec as any;
    const payload = f.store.runtime.context.serialize(pack);
    assert.equal(spec.recipient, '老师');
    assert.equal(spec.purpose, '申请延期');
    assert.deepEqual(spec.allowedFacts, ['周三下午', '目前可以提交']);
    assert.equal(spec.tone, '礼貌自然');
    assert.equal(spec.mode, 'draft');
    assert.ok(payload.includes('申请延期'));
    assert.ok(payload.includes('周三下午'));
    assert.ok(!payload.includes('CANARY_PRIVATE_REASON_421'));
  } finally {
    f.close();
  }
});

test('explicit direct_local executes a reversible local registration and can revoke it', async () => {
  const f = new Fixture();
  try {
    const result = await f.store.runtime.actions.directLocal(f.scope(), {
      capability: 'local.agenda.save',
      arguments: { title: '可撤销登记', detail: 'direct_local test' },
      authorized: true,
    });
    assert.equal(result.action.executionTier, 'direct_local');
    assert.equal(result.receipt.status, 'confirmed_success');
    assert.equal(f.store.agenda().length, 1);
    const cancelled = await f.store.runtime.actions.cancel(f.scope(), result.action.id);
    assert.equal(cancelled?.status, 'cancellation_confirmed');
    assert.equal(f.store.agenda().length, 0);
  } finally {
    f.close();
  }
});

test('separate host delegation verification gives prepare_action a real receipt and replay observes the existing record', async () => {
  const f = new Fixture();
  try {
    const run = f.store.runtime.begin(
      '别给我做学习计划，我就是想吐槽。顺手把明天九点小组会记一下。',
      'direct-local-turn',
      'direct-local-session',
      new AbortController().signal,
    );
    assert.equal(run.ingress.contract.interpretation?.directLocalWrite, false);
    let offered: any;
    const result: any = await f.store.runtime.executeTool(
      run,
      'prepare_action',
      { title: '小组会', detail: '用户本轮明确要求登记。', startsAt: '2026-09-15T09:00:00+08:00' },
      {
        step: () => {},
        plan: () => {},
        action: (item) => {
          offered = item;
        },
        changed: () => {},
        delegate: async () => [],
        verifyLocalDelegation: async () => ({ decision: 'execute_local', basis: [{ id: 'direct-local-turn', quote: run.ingress.authoredText }], missing: [], reason: 'Explicit host test fixture.' }),
      },
    );
    assert.equal(result.executionTier, 'direct_local');
    assert.equal(result.status, 'confirmed_success');
    assert.equal(result.receipt.localStatus, 'local_saved');
    assert.equal(result.undo.operation, 'cancel_local_action');
    assert.equal(offered.saved, true);
    assert.equal(f.store.agenda().length, 1);
    assert.equal(Date.parse(f.store.agenda()[0].startsAt!), Date.parse('2026-09-15T09:00:00+08:00'));
    assert.equal(f.store.agenda()[0].durationMinutes, undefined);
    const replay: any = await f.store.runtime.executeTool(
      run,
      'prepare_action',
      { title: '小组会', detail: '用户本轮明确要求登记。', startsAt: '2026-09-15T09:00:00+08:00' },
      {
        step: () => {},
        plan: () => {},
        action: () => {},
        changed: () => {},
        delegate: async () => [],
        verifyLocalDelegation: async () => ({ decision: 'execute_local', basis: [{ id: 'direct-local-turn', quote: run.ingress.authoredText }], missing: [], reason: 'Explicit host test fixture.' }),
      },
    );
    assert.equal(replay.alreadyPresent, true);
    assert.equal(f.store.agenda().length, 1);
  } finally {
    f.close();
  }
});
