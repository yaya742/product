import test from 'node:test';
import assert from 'node:assert/strict';
import { Fixture, controlProposal } from './support';
import type { RuntimeCallbacks } from '../../src/main/runtime/coordinator';

const base: RuntimeCallbacks = { step() {}, plan() {}, action() {}, changed() {}, delegate: async () => [] };

test('a verified local effect retains its business receipt but not the transient conversation, and can be changed and undone', async () => {
  let f = new Fixture();
  const marker = 'CANARY_TRANSIENT_EFFECT_971';
  try {
    const text = `${marker} 不保存聊天，但登记明天下午三点资料复核，不把私话放入事项。`;
    const run = f.store.runtime.begin(text, 'transient-effect-origin', 'temporary', new AbortController().signal, { retention: 'session_only' });
    assert.ok(f.store.runtime.toolSpecs(run).some(tool => tool.function.name === 'prepare_action'));
    const callbacks: RuntimeCallbacks = { ...base, verifyLocalDelegation: async () => ({ decision: 'execute_local', basis: [{ id: run.events[0].id, quote: text }], missing: [], reason: 'Synthetic exact local delegation.' }) };
    const args = { title: '资料复核', detail: '', startsAt: '2026-09-15T15:00:00+08:00' };
    const result: any = await f.store.runtime.executeTool(run, 'prepare_action', args, callbacks);
    assert.equal(result.saved, true); assert.equal(result.receipt.status, 'confirmed_success');
    assert.equal(f.store.agenda().length, 1); assert.equal(f.store.agenda()[0].durationMinutes, undefined);
    await f.store.runtime.executeTool(run, 'prepare_action', args, callbacks);
    assert.equal(f.store.agenda().length, 1);
    const item = f.store.agenda()[0];
    const changed: any = await f.store.runtime.executeTool(run, 'change_local_action', { operation: 'update', targetId: item.id, expectedRevision: item.revision || 1, changes: { durationMinutes: 30 } }, callbacks);
    assert.equal(changed.applied, true); assert.equal(f.store.agenda()[0].durationMinutes, 30);
    assert.equal(f.repo.watermarks().received, 0); assert.equal(f.repo.db.prepare('SELECT count(*) AS n FROM messages').get()?.n, 0);
    assert.ok(!JSON.stringify(f.store.export()).includes(marker));
    const undoId = changed.actionId;
    f.store.runtime.finish(run); f = f.restart();
    assert.equal(f.store.agenda()[0].durationMinutes, 30);
    await f.store.runtime.actions.cancel(f.scope(), undoId);
    assert.equal(f.store.agenda()[0].durationMinutes, undefined);
    assert.ok(!JSON.stringify(f.store.export()).includes(marker));
  } finally { f.close(); }
});

test('transient turns without verified delegation or with an explicit effect prohibition create no persisted proposal', async () => {
  const f = new Fixture();
  try {
    for (const semantic of [undefined, controlProposal({ actions: 'none', actionsApplyToWholeTurn: true })]) {
      const run = f.store.runtime.begin('不保存聊天，也没有委托登记。', 'not-delegated-' + !!semantic, 'temporary', new AbortController().signal, { retention: 'session_only', semantic });
      const result: any = await f.store.runtime.executeTool(run, 'prepare_action', { title: '不应登记', detail: '' }, { ...base, verifyLocalDelegation: async () => ({ decision: semantic ? 'execute_local' : 'not_requested', basis: [], missing: [], reason: 'The explicit prohibition must remain authoritative.' }) });
      assert.equal(result.saved, false);
    }
    assert.equal(f.store.agenda().length, 0); assert.equal(f.store.runtime.actions.list(f.scope()).length, 0);
    assert.equal(f.repo.watermarks().received, 0);
  } finally { f.close(); }
});

test('the business scope is source-limited and revocable, and opaque transient provenance still cancels pending effects', () => {
  const f = new Fixture();
  try {
    const run = f.store.runtime.begin('只存业务参数。', 'opaque-transient-origin', 'temporary', new AbortController().signal, { retention: 'session_only' });
    const parent = f.policy.validate(run.ingress.contract.scope), effect = f.policy.localEffectScope(run.ingress.contract.scope), data = f.policy.validate(effect);
    assert.deepEqual(data.sources, ['local-agenda']); assert.equal(data.infer, false); assert.equal(data.expiresAt, parent.expiresAt);
    assert.ok(!data.grants.includes('memory:write')); assert.equal(parent.retention, 'session_only');
    assert.throws(() => f.store.runtime.actions.prepare(run.ingress.contract.scope, { capability: 'local.agenda.save', arguments: { title: 'proposal', detail: '' } }), /持久动作/);
    const action = f.store.runtime.actions.prepare(effect, { capability: 'local.agenda.save', arguments: { title: '尚未提交', detail: '' }, dependencies: [{ consumerId: 'pending', producerId: run.events[0].id, producerRevision: 0, sensitivity: 'privacy', invalidation: 'block' }] });
    f.store.runtime.actions.cancelPendingFromSources([run.events[0].id]);
    assert.equal(f.store.runtime.actions.get(f.scope(), action.id)?.status, 'cancelled');
    assert.equal(f.store.agenda().length, 0);
    f.policy.revoke('local:write'); assert.throws(() => f.policy.validate(effect), /范围已改变/);
  } finally { f.close(); }
});
