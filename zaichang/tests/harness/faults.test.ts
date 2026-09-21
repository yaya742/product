import test from 'node:test';
import assert from 'node:assert/strict';
import { Fixture, supported } from './support';
import { CapabilityBroker } from '../../src/main/capabilities/broker';
import { ActionRuntime } from '../../src/main/actions/runtime';
import { ExternalSink } from './sink';
import { Harness } from '../../src/main/harness';
import { ScriptedSemanticClient } from './scripted';
import { build } from 'esbuild';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { testDirectory } from './support';

test('INV-12 actual HTTP commit-with-lost-receipt is unknown, then reconciles after SQLite restart without a second write', async () => {
  const sink = await new ExternalSink().start();
  let f = new Fixture();
  try {
    sink.mode = 'commit_then_disconnect';
    let b = new CapabilityBroker(f.policy);
    b.register(sink.provider(), { reviewed: true, source: 'controlled HTTP sink' });
    f.policy.grant('external:book');
    let runtime = new ActionRuntime(f.repo, f.policy, b, () => {
      throw new Error('Unexpected local write');
    });
    const scope = f.scope(),
      action = runtime.prepare(scope, { capability: 'test.external.book', arguments: { title: '合成预约' } }),
      approval = runtime.approve(scope, action.id, action.digest, action.revision);
    const receipt = await runtime.execute(scope, action.id, approval.id);
    assert.equal(receipt.status, 'unknown');
    assert.equal(runtime.get(scope, action.id)?.status, 'outcome_unknown');
    assert.equal(sink.effects.size, 1);
    f = f.restart();
    b = new CapabilityBroker(f.policy);
    b.register(sink.provider(), { reviewed: true, source: 'controlled HTTP sink' });
    runtime = new ActionRuntime(f.repo, f.policy, b, () => {});
    await runtime.reconcile(f.scope(), action.id);
    assert.equal(runtime.get(f.scope(), action.id)?.status, 'succeeded');
    assert.equal(sink.effects.size, 1);
    assert.equal(sink.requests.filter((r) => r.method === 'POST').length, 1);
    assert.equal(sink.requests.filter((r) => r.method === 'GET').length, 1);
  } finally {
    f.close();
    await sink.close();
  }
});
test('INV-12 lost receipt on server failure has the same unknown state before inspection', async () => {
  const sink = await new ExternalSink().start(),
    f = new Fixture();
  try {
    sink.mode = 'fail_then_disconnect';
    const b = new CapabilityBroker(f.policy);
    b.register(sink.provider(), { reviewed: true, source: 'sink' });
    f.policy.grant('external:book');
    const runtime = new ActionRuntime(f.repo, f.policy, b, () => {}),
      s = f.scope(),
      a = runtime.prepare(s, { capability: 'test.external.book', arguments: { title: '失败的合成预约' } }),
      approval = runtime.approve(s, a.id, a.digest, 1);
    assert.equal((await runtime.execute(s, a.id, approval.id)).status, 'unknown');
    assert.equal(sink.effects.size, 0);
    await runtime.reconcile(s, a.id);
    assert.equal(runtime.get(s, a.id)?.status, 'failed_confirmed');
    assert.equal(sink.requests.filter((r) => r.method === 'POST').length, 1);
  } finally {
    f.close();
    await sink.close();
  }
});
test('INV-12 provider without inspect remains unresolved and does not create a new idempotency key', async () => {
  const sink = await new ExternalSink().start();
  let f = new Fixture();
  try {
    sink.mode = 'disconnect_unknown';
    let b = new CapabilityBroker(f.policy);
    b.register(sink.provider(false), { reviewed: true, source: 'sink' });
    f.policy.grant('external:book');
    let runtime = new ActionRuntime(f.repo, f.policy, b, () => {});
    const s = f.scope(),
      a = runtime.prepare(s, { capability: 'test.external.no_inspect', arguments: { title: '核查不支持' } }),
      approval = runtime.approve(s, a.id, a.digest, 1);
    await runtime.execute(s, a.id, approval.id);
    f = f.restart();
    b = new CapabilityBroker(f.policy);
    b.register(sink.provider(false), { reviewed: true, source: 'sink' });
    runtime = new ActionRuntime(f.repo, f.policy, b, () => {});
    await runtime.reconcile(f.scope(), a.id);
    assert.equal(runtime.get(f.scope(), a.id)?.status, 'unresolved');
    assert.equal(sink.requests.length, 1);
    await assert.rejects(() => runtime.execute(f.scope(), a.id, approval.id), /先核查/);
    assert.equal(sink.requests.length, 1);
  } finally {
    f.close();
    await sink.close();
  }
});
test('INV-16 real committed event/outbox survives restart and is processed exactly once after injected crash', async () => {
  let f = new Fixture();
  try {
    f.repo.fault = (point) => {
      if (point === 'after_event_and_outbox_commit') throw new Error('synthetic crash');
    };
    assert.throws(() => f.ingest('我喜欢直观例子。', 'crash-event'), /synthetic crash/);
    f = f.restart();
    f.memory.extractor = async (event) => ({
      status: 'candidate_emitted',
      changes: [
        f.change(event, {
          predicate: 'explanation.intuition_first',
          value: { type: 'boolean', value: true },
          idempotencyKey: 'crash-retry',
        }),
      ],
    });
    f.memory.reviewer = async () => supported;
    await f.memory.drain();
    await f.memory.drain();
    assert.equal(f.repo.assertions(f.scope()).length, 1);
    assert.equal(f.repo.watermarks().received, 1);
    assert.equal(f.repo.watermarks().extractedContiguous, 1);
  } finally {
    f.close();
  }
});
test('INV-16 transaction fault leaves neither assertion nor dangling source relation nor completed operation', async () => {
  const f = new Fixture();
  try {
    const e = f.ingest('我喜欢安静。');
    f.repo.fault = (point) => {
      if (point === 'before_transaction_commit') throw new Error('rollback');
    };
    await assert.rejects(
      () =>
        f.memory.propose(f.scope(), f.change(e, { idempotencyKey: 'rollback-key' }), undefined, {
          review: supported,
        }),
      /rollback/,
    );
    f.repo.fault = undefined;
    assert.equal(f.repo.assertions(f.scope()).length, 0);
    assert.equal(f.repo.db.prepare('SELECT count(*) AS n FROM h_assertion_evidence').get()?.n, 0);
    assert.equal(f.repo.operation('memory:rollback-key'), undefined);
    assert.equal(f.repo.evidence(f.scope(), e.id)?.text, e.text);
  } finally {
    f.close();
  }
});
test('INV-16 actual Harness recovery resumes persisted pending extraction using the original event date', async () => {
  let f = new Fixture();
  try {
    f.ingest('今天不想跑，只代表今天。', 'pending-day');
    f = f.restart();
    f.clock.set('2026-09-15T06:00:00Z');
    f.store.saveSettings({ mode: 'deepseek' });
    const client = new ScriptedSemanticClient(),
      harness = new Harness(
        f.store,
        () => 'synthetic',
        () => {},
        () => client,
      );
    await harness.recoverPending();
    const assertion = f.repo
      .assertions(f.scope(), { statuses: ['active'] })
      .find((a) => a.predicate === 'running.today_allowed')!;
    assert.ok(assertion);
    assert.ok(Date.parse(assertion.temporal.validTo!) < Date.parse(f.clock.now()));
    assert.equal(f.repo.watermarks().extractionGaps.length, 0);
  } finally {
    f.close();
  }
});
test('INV-16 abrupt process exit after ingress commit recovers the original conversation from WAL evidence', async () => {
  const dir = testDirectory('process-crash'),
    entry = path.join(dir, 'crash.cjs'),
    file = path.join(dir, 'test.sqlite');
  await build({
    entryPoints: ['tests/harness/crash-process.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: entry,
    loader: { '.md': 'text' },
    packages: 'external',
  });
  const child = spawnSync(process.execPath, [entry, file, '--attachment'], {
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(child.status, 74, child.stderr);
  const f = new Fixture(dir);
  try {
    assert.equal(
      f.store.messages('crash-conversation')[0].content,
      '进程中断前的合成输入已接收。\n\n[用户附上的文字资料：附件.md]\n附件尾部 CRASH_ATTACHMENT_TAIL',
    );
    assert.equal(f.store.messages('crash-conversation')[1].status, 'cancelled');
    assert.equal(f.repo.watermarks().received, 2);
    assert.ok(f.repo.pending('extract').length >= 1);
  } finally {
    f.close();
  }
});
