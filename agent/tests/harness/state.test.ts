import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Fixture } from './support';
import { DomainService } from '../../src/main/storage/domains';
import { WorkService } from '../../src/main/runtime/work';
import { CapabilityBroker, type CapabilityProvider } from '../../src/main/capabilities/broker';
import { ActionRuntime } from '../../src/main/actions/runtime';
import { ReminderRuntime } from '../../src/main/actions/reminders';
import { always } from '../../src/shared/harness';

export function localProvider(): CapabilityProvider {
  return {
    manifest: {
      id: 'local-agenda-provider',
      version: '1',
      trust: 'bundled_reviewed',
      sourceId: 'local-agenda',
      capabilities: [
        {
          name: 'local.agenda.save',
          version: '1',
          input: z
            .object({
              title: z.string(),
              detail: z.string().default(''),
              startsAt: z.string().optional(),
              durationMinutes: z.number().optional(),
            })
            .strict(),
          output: z.object({}).strict(),
          effect: 'local_write',
          requiredScopes: ['local:write'],
          subjects: ['self'],
          worlds: ['real'],
          timeoutMs: 1000,
          maxBytes: 8000,
          supportsIdempotency: true,
          supportsInspect: true,
          supportsCancel: true,
        },
      ],
      egressHosts: [],
      platforms: ['*'],
      simulated: false,
      offline: 'read_cache',
      license: 'project-owned',
    },
    invoke: () => {
      throw new Error('Local transaction handled by ActionRuntime');
    },
  };
}

test('INV-13 campus partial sports updates preserve schedule and official count cannot be changed by local done', () => {
  const f = new Fixture();
  try {
    const d = new DomainService(f.repo, f.policy);
    d.importSnapshot({
      source: '虚构课程',
      updatedAt: f.clock.now(),
      schedule: [
        {
          id: 'class-1',
          title: '测试课程',
          startsAt: '2026-09-14T08:00:00Z',
          endsAt: '2026-09-14T09:00:00Z',
          status: 'scheduled',
          location: '教室A',
          source: '虚构',
        },
      ],
      exams: [],
      places: [],
      rules: [],
      sports: { completed: 9, required: 12, deadline: '2026-09-28T00:00:00Z', ruleSource: '虚构规则' },
    });
    d.importSnapshot(
      {
        source: '虚构体育',
        updatedAt: f.clock.now(),
        schedule: [],
        exams: [],
        places: [],
        rules: [],
        sports: { completed: 10, required: 12, deadline: '2026-09-28T00:00:00Z', ruleSource: '虚构规则' },
      },
      ['sports'],
    );
    assert.equal(d.campusSnapshot()?.schedule[0].id, 'class-1');
    assert.equal(d.campusSnapshot()?.sports?.completed, 10);
    d.apply(f.scope(), {
      sourceId: 'campus:local',
      domain: 'schedule',
      institutionId: 'zju',
      termId: 'unspecified',
      scopeKeys: ['all'],
      completeness: 'partial',
      upserts: [],
      tombstones: [],
      fetchedAt: f.clock.now(),
      errors: [],
    });
    assert.equal(d.campusSnapshot()?.schedule.length, 1);
    f.store.saveAction({ id: 'local', title: '跑完了', detail: '本地完成', done: true });
    assert.equal(d.campusSnapshot()?.sports?.completed, 10);
  } finally {
    f.close();
  }
});
test('INV-04/12 duplicate approvals result in one real SQLite local write and a local-only receipt', async () => {
  const f = new Fixture();
  try {
    const b = new CapabilityBroker(f.policy);
    b.register(localProvider(), { reviewed: true, source: 'test-fixture' });
    let writes = 0;
    const actions = new ActionRuntime(f.repo, f.policy, b, (a) => {
      writes++;
      f.store.saveAction(a);
    });
    const scope = f.scope(),
      a = actions.prepare(scope, { capability: 'local.agenda.save', arguments: { title: '本地安排' } }),
      approval = actions.approve(scope, a.id, a.digest, a.revision);
    assert.equal(f.store.agenda().length, 0);
    await Promise.all(Array.from({ length: 3 }, () => actions.execute(scope, a.id, approval.id)));
    assert.equal(writes, 1);
    assert.equal(f.store.agenda().length, 1);
    assert.equal(actions.receipts(scope, a.id)[0].localStatus, 'local_saved');
    assert.equal(actions.get(scope, a.id)?.status, 'succeeded');
  } finally {
    f.close();
  }
});
test('INV-12 digest-bound approval expires on argument revision', async () => {
  const f = new Fixture();
  try {
    const b = new CapabilityBroker(f.policy);
    b.register(localProvider(), { reviewed: true, source: 'test' });
    const actions = new ActionRuntime(f.repo, f.policy, b, (a) => f.store.saveAction(a));
    const s = f.scope(),
      a = actions.prepare(s, { capability: 'local.agenda.save', arguments: { title: '旧内容' } }),
      approval = actions.approve(s, a.id, a.digest, 1);
    actions.revise(s, a.id, 1, { title: '新内容' });
    await assert.rejects(() => actions.execute(s, a.id, approval.id), /确认已失效/);
    assert.equal(f.store.agenda().length, 0);
  } finally {
    f.close();
  }
});
test('INV-08 pre-dispatch revocation actually blocks a previously approved action', async () => {
  const f = new Fixture();
  try {
    const b = new CapabilityBroker(f.policy);
    b.register(localProvider(), { reviewed: true, source: 'test' });
    const actions = new ActionRuntime(f.repo, f.policy, b, (a) => f.store.saveAction(a));
    const s = f.scope(),
      a = actions.prepare(s, { capability: 'local.agenda.save', arguments: { title: '待确认' } }),
      approval = actions.approve(s, a.id, a.digest, 1);
    actions.beforeDispatch = async () => {
      f.policy.revoke('local:write');
    };
    await assert.rejects(() => actions.execute(s, a.id, approval.id), /已改变/);
    assert.equal(f.store.agenda().length, 0);
    assert.equal(actions.get(f.scope(), a.id)?.status, 'cancelled');
  } finally {
    f.close();
  }
});
test('INV-18 goal cancellation invalidates reminder jobs and accepted work is not silently replanned', async () => {
  const f = new Fixture();
  try {
    const work = new WorkService(f.repo, f.policy),
      s = f.scope(),
      goal = work.create(s, 'goal', '竞赛准备', {}, { status: 'active' });
    const reminders = new ReminderRuntime(f.repo, f.policy);
    reminders.schedule({ id: 'prep', title: '准备', detail: '', startsAt: f.clock.now() }, goal.id);
    const accepted = work.create(s, 'plan', '已接受的学习', { accepted: true }, { status: 'accepted' });
    work.cancelGoal(s, goal.id);
    assert.equal(f.repo.db.prepare('SELECT status FROM h_jobs').get()?.status, 'cancelled');
    assert.deepEqual(work.repair(s, { weather: 'rain' }).find((p) => p.id === accepted.id)?.next, accepted.data);
  } finally {
    f.close();
  }
});
test('INV-17 quiet hours, attention budget and real OS receipt limitations are preserved', async () => {
  const f = new Fixture();
  try {
    const reminders = new ReminderRuntime(f.repo, f.policy);
    reminders.configure({ enabled: true, quietWindows: [['22:00', '08:00']] });
    reminders.port = {
      capabilities: { submitted: true, delivered: false, seen: false, stableId: false, closedApp: false },
      submit: async () => ({ status: 'submitted_to_os' }),
    };
    for (let i = 0; i < 10; i++)
      reminders.schedule({ id: 'r' + i, title: '提醒' + i, detail: '', startsAt: '2026-09-14T06:00:00Z' });
    f.clock.set('2026-09-14T15:00:00Z');
    await reminders.runDue();
    assert.equal(reminders.submitted.length, 0);
    f.clock.set('2026-09-15T01:00:00Z');
    await reminders.runDue();
    assert.equal(reminders.submitted.length, 1);
    assert.equal(reminders.submitted[0].status, 'submitted_to_os');
    assert.equal(reminders.capabilities().closedAppReminders, false);
    await reminders.runDue();
    assert.equal(reminders.submitted.length, 1);
  } finally {
    f.close();
  }
});
test('INV-03/04 stable image option anchors survive reorder and hypothetical adoption prepares tasks only', () => {
  const f = new Fixture();
  try {
    const work = new WorkService(f.repo, f.policy),
      s = f.scope();
    const episode = work.create(s, 'episode', '比较', { optionIds: [] }, { status: 'active' });
    work.addOptions(
      s,
      episode.id,
      [
        { id: 'a', title: '甲' },
        { id: 'b', title: '乙' },
      ],
      ['a', 'b'],
    );
    assert.equal(work.resolveReference(s, episode.id, '选第二个').optionId, 'b');
    const e = f.repo.work(s, 'episode')[0];
    work.update(s, e.id, e.revision, { data: { ...e.data, optionIds: ['b', 'a'] } });
    assert.equal(work.resolveReference(s, e.id, '继续比较刚刚那个').optionId, 'b');
    work.createWorld(s, 'dorm', { application: 'dorm' });
    const diff = work.adoptionDiff(s, 'dorm');
    work.adoptPreparation(s, 'dorm', [diff.items[0].id]);
    assert.equal(f.repo.work(s, 'task').length, 1);
    assert.equal(f.repo.assertions(s).length, 0);
    assert.equal(f.repo.work(s, 'commitment').length, 0);
  } finally {
    f.close();
  }
});

test('conversation frames keep multiple matters, resume a tangent and recover options across sessions', () => {
  const f = new Fixture();
  try {
    const work = new WorkService(f.repo, f.policy),
      s = f.scope(),
      first = f.ingest('比较宿舍和校外住处方案', 'frame-a1'),
      episodeA = work.episode(s, 'session-a', first.text, [first.id])!;
    work.addOptions(s, episodeA.id, [{ id: 'stay-dorm', title: '宿舍' }, { id: 'stay-out', title: '校外' }]);
    const tangent = f.ingest('下周安排跑步训练', 'frame-b1'),
      episodeB = work.episode(s, 'session-a', tangent.text, [tangent.id])!;
    assert.notEqual(episodeA.id, episodeB.id, 'unrelated request in one chat gets its own episode');
    work.addOptions(s, episodeB.id, [{ id: 'run-morning', title: '晨跑' }, { id: 'run-evening', title: '夜跑' }]);
    const returnTurn = f.ingest('继续刚才那个', 'frame-a-return'),
      resumed = work.episode(s, 'session-a', returnTurn.text, [returnTurn.id])!;
    assert.equal(resumed.id, episodeA.id, 'the tangent keeps a parent focus chain');
    assert.equal(work.resolveReference(s, episodeA.id, '选第二个').optionId, 'stay-out');

    const crossSession = f.ingest('继续宿舍方案的比较', 'frame-a2'),
      resumedFromNewChat = work.episode(s, 'session-b', crossSession.text, [crossSession.id])!;
    assert.equal(resumedFromNewChat.id, episodeA.id, 'semantic anchor resumes an episode in another session');
    assert.ok((resumedFromNewChat.data.sessionIds as string[]).includes('session-b'));
    assert.equal(f.repo.conversationFrames(s, { sessionId: 'session-b' }).length, 1);
    const evidenceResumed = work.episode(s, 'session-c', '接着处理这份资料', [first.id])!;
    assert.equal(evidenceResumed.id, episodeA.id, 'shared surviving evidence is a stable cross-session anchor');
  } finally {
    f.close();
  }
});

test('deleted evidence cannot resurrect a conversation frame or its option reference', () => {
  const f = new Fixture();
  try {
    const work = new WorkService(f.repo, f.policy),
      s = f.scope(),
      event = f.ingest('比较保留的学习地点', 'frame-delete'),
      episode = work.episode(s, 'session-delete', event.text, [event.id])!;
    work.addOptions(s, episode.id, [{ id: 'library', title: '图书馆' }, { id: 'home', title: '家里' }]);
    const fence = f.repo.establishFence({ kind: 'delete', objectIds: [], sourceIds: ['history:self'] });
    f.repo.cleanupFence(fence);
    const rebuilt = f.scope();
    assert.equal(f.repo.conversationFrames(rebuilt).length, 0);
    assert.equal(work.resolveCurrentReference(rebuilt, 'session-new', '选第二个').status, 'none');
  } finally {
    f.close();
  }
});
test('INV-05 ISO offsets compare as instants for reminders and evidence expiry', async () => {
  const f = new Fixture();
  try {
    f.ingest('这条资料已经过期。', 'expired-offset', {
      label: {
        purpose: 'personal_assistance',
        audience: 'self',
        retention: 'purpose_scoped',
        sensitivity: 'personal',
        infer: false,
        expiresAt: '2026-09-14T13:30:00+08:00',
      },
    });
    assert.equal(f.repo.evidence(f.scope(), 'expired-offset'), undefined);
    const reminders = f.store.runtime.reminders;
    reminders.configure({ enabled: true, quietWindows: [] });
    reminders.port = {
      capabilities: { submitted: true, delivered: false, seen: false, stableId: false, closedApp: false },
      submit: async () => ({ status: 'submitted_to_os' }),
    };
    reminders.schedule({
      id: 'offset-action',
      title: '当地14点',
      detail: '',
      startsAt: '2026-09-14T14:00:00+08:00',
    });
    await reminders.runDue();
    assert.equal(reminders.submitted.length, 1);
  } finally {
    f.close();
  }
});
