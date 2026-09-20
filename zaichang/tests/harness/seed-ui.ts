import { Store } from '../../src/main/store';
import path from 'node:path';
import fs from 'node:fs';
import { always, personalLabel } from '../../src/shared/harness';
async function main() {
  const file = path.join(process.env.ZAICHANG_DATA_DIR!, 'zaichang.sqlite'),
    store = new Store(file),
    r = store.runtime,
    repo = store.kernel;
  const now = repo.clock.now(),
    sessionId = store.session('ui-session', '准备社团分享 · 合成资料');
  const memory = r.memory.saveControl('我更喜欢安静的地方，只有需要讨论时才选择热闹的空间。');
  const inactive = r.memory.saveControl('我平时喜欢在咖啡馆读书。');
  r.memory.deactivate(inactive.id);
  const eventId = 'ui-pending',
    scope = r.policy.hostScope({ currentEventIds: [eventId] });
  repo.ingest(scope, {
    id: eventId,
    ownerId: repo.identity.principalId,
    workspaceId: repo.identity.workspaceId,
    subjectId: repo.identity.principalId,
    worldId: 'real',
    sourceId: 'history:self',
    contentVersion: 1,
    text: '我下个月可能搬到新住处，具体哪一天还没确定。',
    speaker: 'user',
    kind: 'user_message',
    authority: 'user_statement',
    roots: [eventId],
    label: { ...personalLabel },
    receivedAt: now,
    status: 'active',
  });
  await r.memory.propose(
    scope,
    {
      operation: 'ADD',
      eventId,
      sourceQuote: '我下个月可能搬到新住处，具体哪一天还没确定。',
      predicate: 'residence.future',
      text: '下个月可能搬家，日期待确认',
      value: { type: 'text', value: '新住处' },
      kind: 'explicit_fact',
      strength: 'unconfirmed',
      conditions: always,
      unresolvedTime: '下个月，日期未定',
      idempotencyKey: 'ui-candidate',
    },
    undefined,
    {
      review: {
        supported: true,
        preservesSubject: true,
        preservesWorld: true,
        preservesTime: true,
        preservesConditions: true,
        reason: 'synthetic UI fixture review',
      },
    },
  );
  const host = r.policy.hostScope(),
    goal = r.work.create(
      host,
      'goal',
      '准备社团分享',
      { reason: '先把想讲的两件小事理清楚，不必占满空闲时间。' },
      { status: 'proposed', evidenceIds: [eventId] },
    );
  const episode = r.work.episode(host, sessionId, '准备社团分享', [eventId])!;
  r.work.update(host, episode.id, episode.revision, {
    data: { ...episode.data, nextSmallQuestion: '想先从哪段经历讲起？' },
  });
  const a = r.actions.prepare(host, {
    capability: 'local.agenda.save',
    arguments: { title: '整理分享提纲', detail: '留出半小时，只整理已有想法。', durationMinutes: 30 },
  });
  const unknown = r.actions.prepare(host, {
    capability: 'local.agenda.save',
    arguments: { title: '场地申请 · 模拟状态', detail: '受控未知回执展示' },
  });
  Object.assign(unknown, {
    status: 'outcome_unknown',
    capability: 'synthetic.external.unconnected',
    effect: 'external_write',
    simulated: true,
  });
  repo.db
    .prepare('UPDATE h_actions SET status=?,payload=? WHERE id=?')
    .run(unknown.status, JSON.stringify(unknown), unknown.id);
  const base = {
    sessionId,
    createdAt: now,
    status: 'done' as const,
    steps: [],
    obligations: [],
    actions: [],
  };
  store.putMessage({ ...base, id: 'ui-user', role: 'user', content: '我想准备一次社团分享，也留点空闲。' });
  store.putMessage({
    ...base,
    id: 'ui-answer',
    role: 'assistant',
    content:
      '可以先把想讲的两件小事写下来。场地还没有确认，先留出一点空间。\n\n这只是合成测试资料，不是实际校园记录。',
    actions: [
      {
        id: a.id,
        title: '整理分享提纲',
        detail: '留出半小时，只整理已有想法。',
        durationMinutes: 30,
        revision: a.revision,
        approvalDigest: a.digest,
        coverage: 'conditional',
        missingNeeds: ['device.availability'],
      },
    ],
    scopeSummary: {
      memoryMode: 'relevant',
      retention: 'purpose_scoped',
      audience: 'self',
      interactionMode: 'normal',
      interpretation: {
        posture: 'mixed',
        fragmentCount: 2,
        explicitLocalWrite: false,
        unresolvedReferences: ['刚才那个'],
      },
    },
  });
  fs.writeFileSync(
    path.join(process.env.ZAICHANG_DATA_DIR!, 'ui-ids.json'),
    JSON.stringify({ sessionId, memoryId: memory.id, goalId: goal.id, unknownId: unknown.id }),
  );
  store.close();
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
