import test from 'node:test';
import assert from 'node:assert/strict';
import { always, personalLabel, type ScopeHandle } from '../../src/shared/harness';
import {
  evaluateCondition,
  locateQuote,
  codePointSlice,
  dateInZone,
  resolveLocalTime,
} from '../../src/main/runtime/semantics';
import { Fixture, supported, controlProposal } from './support';

test('INV-01/02 forged scopes, owner and source isolation are checked before reading', () => {
  const f = new Fixture();
  try {
    f.ingest('CANARY_OTHER', 'other-source', { subjectId: 'other' });
    f.ingest('CANARY_PRIVATE', 'private');
    assert.throws(() => f.repo.evidence({ id: 'invented' } as ScopeHandle, 'private'), /可信作用域/);
    const scope = f.scope({ sources: ['current'], currentEventIds: [] });
    assert.equal(f.repo.evidence(scope, 'private'), undefined);
    assert.equal(f.repo.searchEvidence(scope, 'CANARY').length, 0);
    assert.equal(f.repo.evidence(f.scope(), 'other-source'), undefined);
    assert.throws(() => f.policy.narrow(scope, { sources: ['history:self'] }), /扩大/);
    assert.equal(f.repo.access.length, 0);
  } finally {
    f.close();
  }
});
test('INV-05 three-valued conditions preserve unknown through NOT and reject incomparable units', () => {
  assert.equal(
    evaluateCondition(
      {
        op: 'not',
        term: { op: 'compare', predicate: 'rain', comparator: 'eq', value: { type: 'boolean', value: true } },
      },
      {},
    ),
    'unknown',
  );
  assert.equal(
    evaluateCondition(
      {
        op: 'all',
        terms: [
          { op: 'unknown', reason: 'missing' },
          { op: 'compare', predicate: 'allowed', comparator: 'eq', value: { type: 'boolean', value: true } },
        ],
      },
      { allowed: { type: 'boolean', value: false } },
    ),
    'false',
  );
  assert.equal(
    evaluateCondition(
      {
        op: 'compare',
        predicate: 'distance',
        comparator: 'lt',
        value: { type: 'quantity', value: 48, unit: 'count', dimension: 'count' },
      },
      { distance: { type: 'quantity', value: 48, unit: 'km', dimension: 'distance' } },
    ),
    'unknown',
  );
});
test('INV-05 timezone dates and nonexistent/ambiguous DST moments require confirmation', () => {
  assert.equal(dateInZone('2026-09-14T23:30:00-07:00', 'Asia/Shanghai'), '2026-09-15');
  assert.equal(resolveLocalTime('2026-03-08T02:30:00', 'America/Los_Angeles').status, 'nonexistent');
  assert.equal(resolveLocalTime('2026-11-01T01:30:00', 'America/Los_Angeles').status, 'ambiguous');
});
test('INV-06 Unicode code point source locators round-trip emoji and Chinese', () => {
  const text = '🧭今天从主图出发。';
  const loc = locateQuote(text, '主图');
  assert.equal(loc.start, 4);
  assert.equal(codePointSlice(text, loc.start, loc.end), '主图');
});
test('INV-16 duplicate event id is idempotent and contradictory replay is rejected', () => {
  const f = new Fixture();
  try {
    f.ingest('相同事件', 'dup');
    f.ingest('相同事件', 'dup');
    assert.equal(f.repo.watermarks().received, 1);
    assert.throws(() => f.ingest('不同正文', 'dup'), /原文不同/);
  } finally {
    f.close();
  }
});
test('INV-16 contiguous watermarks never skip failed sequence; original channel covers unindexed tail', () => {
  const f = new Fixture();
  try {
    for (let i = 1; i <= 3; i++) f.ingest('原文' + i, 'e' + i);
    const s = f.scope();
    f.repo.markSpans(s, 'e2', 'no_personal_fact');
    f.repo.markSpans(s, 'e3', 'no_personal_fact');
    f.repo.markSpans(s, 'e1', 'failed');
    assert.equal(f.repo.watermarks().extractedContiguous, 0);
    assert.deepEqual(f.repo.watermarks().extractionGaps, [1]);
    f.repo.indexEvidence(s, 'e3');
    assert.equal(f.repo.watermarks().indexedContiguous, 0);
    assert.equal(f.repo.searchEvidence(s, '原文3')[0].id, 'e3');
  } finally {
    f.close();
  }
});
test('INV-06/16 semantic candidates commit atomically and independent source roots are deduplicated', async () => {
  const f = new Fixture();
  try {
    const e = f.ingest('我喜欢安静。', 'root');
    const change = f.change(e);
    const a = await f.memory.propose(f.scope(), change, undefined, { review: supported });
    const duplicate = await f.memory.propose(f.scope(), change, undefined, { review: supported });
    assert.equal(a.id, duplicate.id);
    const repeated = f.ingest(e.text, 'repeated', { roots: ['root'] });
    await f.memory.propose(
      f.scope(),
      f.change(repeated, { operation: 'SUPPORT', targetId: a.id, expectedRevision: 1 }),
      undefined,
      { review: supported },
    );
    assert.equal(f.repo.assertion(f.scope(), a.id)?.evidenceIds.length, 1);
    const correction = f.ingest('我喜欢更安静的地方。');
    await f.memory.propose(
      f.scope(),
      f.change(correction, { operation: 'CORRECT', targetId: a.id, expectedRevision: 1 }),
      undefined,
      { review: supported },
    );
    await assert.rejects(
      () =>
        f.memory.propose(
          f.scope(),
          f.change(correction, { operation: 'CORRECT', targetId: a.id, expectedRevision: 1 }),
          undefined,
          { review: supported },
        ),
      /新版本/,
    );
    assert.equal(f.repo.conflicts.length, 1);
    assert.equal(f.repo.assertion(f.scope(), a.id)?.revision, 2);
  } finally {
    f.close();
  }
});
test('INV-03/05 semantic review rejects unsupported personality and missing temporary validity', async () => {
  const f = new Fixture();
  try {
    const e = f.ingest('我今天不想去。');
    await assert.rejects(
      () =>
        f.memory.propose(
          f.scope(),
          f.change(e, {
            predicate: 'personality.dislikes_socializing',
            value: { type: 'boolean', value: true },
          }),
          undefined,
          { review: { ...supported, supported: false } },
        ),
      /语义核验/,
    );
    await assert.rejects(
      () => f.memory.propose(f.scope(), f.change(e), undefined, { review: { ...supported, temporalType: 'temporary' } }),
      /期限/,
    );
    assert.equal(f.repo.assertions(f.scope()).length, 0);
  } finally {
    f.close();
  }
});
test('INV-02/08 contract restrictions precede retention, providers and subsequent reads', () => {
  const f = new Fixture();
  try {
    const d = f.policy.ingress(
      '只根据附件总结，不使用以前对我的了解。',
      'request',
      { memoryEnabled: true, weatherEnabled: true },
      { memoryMode: 'current_sources_only', attachment: { id: 'file', name: '文档', text: '仅资料' } },
    );
    assert.equal(d.contract.memoryMode, 'current_sources_only');
    assert.deepEqual(f.policy.validate(d.contract.scope).sources, ['current']);
    const e = f.policy.ingress('这句话只用于本轮，不保存：CANARY_EPHEMERAL', 'tmp', {
      memoryEnabled: true,
      weatherEnabled: true,
    });
    assert.equal(e.contract.retention, 'session_only');
    const s = f.scope();
    f.policy.revoke('campus:read');
    assert.throws(() => f.repo.searchEvidence(s, 'anything'), /已改变/);
  } finally {
    f.close();
  }
});
test('INV-09 deletion redacts source, FTS, legacy views and blocks stale worker commit after restart', async () => {
  let f = new Fixture();
  try {
    const a = await f.remember('我喜欢CANARY_FORGET。');
    const oldScope = f.scope();
    const event = f.ingest('我喜欢CANARY_FORGET。', 'pending');
    f.memory.forget([a.id]);
    await assert.rejects(
      () => f.memory.propose(oldScope, f.change(event), undefined, { review: supported }),
      /已改变/,
    );
    assert.equal(f.repo.searchEvidence(f.scope(), 'CANARY_FORGET').length, 1); // independent newly supplied source survives deletion of one assertion's evidence span
    f.memory.forget([], ['pending']);
    f = f.restart();
    assert.equal(f.repo.searchEvidence(f.scope(), 'CANARY_FORGET').length, 0);
    assert.equal(f.repo.assertions(f.scope()).length, 0);
  } finally {
    f.close();
  }
});
test('INV-03/18 quoted commands do not revoke and mixed originals remain available without lexical fact extraction', async () => {
  const f = new Fixture();
  try {
    const before = f.repo.epoch,
      quoted = f.policy.ingress('分析这句话：“现在撤回健康权限”。不要执行。', 'quoted-control', {
        memoryEnabled: true,
        weatherEnabled: true,
      }, { memoryMode: 'current_sources_only' });
    assert.equal(f.repo.epoch, before);
    assert.equal(quoted.contract.memoryMode, 'current_sources_only');
    const run = f.store.runtime.begin(
      '替室友比较搬家；别改日程；我今天没骑车。',
      'mixed',
      'mixed-thread',
      new AbortController().signal,
      { semantic: controlProposal({ subject: 'mixed', world: 'mixed' }) },
    );
    const acts = run.ingress.speechActs;
    assert.deepEqual(acts, []);
    const pack = await f.store.runtime.compile(run);
    assert.equal((pack.data.currentFacts as any)['transport.current'], undefined);
    assert.ok(pack.currentText.includes('替室友比较搬家'));
    assert.ok(pack.currentText.includes('我今天没骑车'));
    assert.equal(f.policy.validate(run.ingress.contract.scope).infer, false);
  } finally {
    f.close();
  }
});

test('T06 memory extraction defers an isolated qualifying short sentence until context is available', async () => {
  const f = new Fixture();
  try {
    const sessionId = 't06-session',
      question = f.ingest('只讨论下周：是否把项目讨论排在工作日晚上？先不写日程。', 't06-question', { sessionId });
    f.repo.markSpans(f.scope(), question.id, 'no_personal_fact');
    const event = f.ingest('可以，但周末不行。', 't06-answer', { sessionId });
    let seenContext: any;
    f.memory.extractor = async (_event, span) => {
      seenContext = span.context;
      return { status: 'needs_context', changes: [] };
    };
    await f.memory.process(f.scope(), event.id, undefined, {
      priorEvents: [{ id: question.id, speaker: 'user', text: question.text, subjectId: question.subjectId, worldId: question.worldId }],
    });
    assert.ok(seenContext?.priorEvents?.some((item: any) => item.id === question.id));

    const isolated = f.ingest('可以，但周末不行。', 't06-isolated', { sessionId: 't06-isolated-session' });
    let called = false;
    f.memory.extractor = async () => {
      called = true;
      return { status: 'needs_context', changes: [] };
    };
    await f.memory.process(f.scope(), isolated.id);
    assert.equal(called, true, 'the semantic extractor sees the original; no short-phrase classifier decides first');
    assert.equal(f.repo.spans(f.scope(), isolated.id)[0].status, 'needs_context');
  } finally {
    f.close();
  }
});

test('T07 same-day original correction remains immediately available while extraction is paused', async () => {
  const f = new Fixture();
  try {
    const sessionId = f.store.session('t07-session', '去教学楼'),
      correction = f.ingest('今天我没有骑车，车在修。', 't07-correction', { sessionId });
    f.store.putMessage({
      id: correction.id,
      sessionId,
      role: 'user',
      content: correction.text,
      createdAt: f.clock.now(),
      status: 'done',
      steps: [],
      obligations: [],
      actions: [],
    });
    f.memory.paused = true;
    const run = f.store.runtime.begin(
        '现在去教学楼要留多久？',
        't07-route',
        sessionId,
        new AbortController().signal,
      ),
      pack = await f.store.runtime.compile(run);
    assert.ok(JSON.stringify(pack.data.history).includes('今天我没有骑车，车在修。'));
    assert.equal((pack.data.currentFacts as any)['transport.current'], undefined, 'not riding is not a host-invented walking fact');
    assert.ok(f.repo.spans(f.scope(), correction.id).some((span) => span.status === 'pending'));
  } finally {
    f.close();
  }
});

test('T23 long evidence preserves the final negation in the worker context', async () => {
  const f = new Fixture();
  try {
    const prefix = '这是一段不包含新授权的学习背景。'.repeat(700),
      suffix = '最重要的最后补充：今天没带电脑，而且不要给我安排任何回家的路线。',
      event = f.ingest(prefix + suffix, 't23-long');
    let tail = '';
    f.memory.extractor = async (_event, span) => {
      if (span.context?.current?.tailText) tail = span.context.current.tailText;
      return { status: 'no_personal_fact', changes: [] };
    };
    await f.memory.process(f.scope(), event.id);
    assert.ok(tail.includes('今天没带电脑'));
    assert.ok(tail.includes('不要给我安排任何回家的路线'));
  } finally {
    f.close();
  }
});

test('original wording does not manufacture deterministic domain needs before the model chooses evidence', () => {
  const f = new Fixture();
  try {
    const ingress = f.policy.ingress('怎么去这栋楼，顺便看看天气、判断是否跑步合适。', 'need-importance', f.store.settings()),
      needs = f.store.runtime.context.initialNeeds(ingress.contract, ingress.authoredText);
    assert.deepEqual(needs, []);
  } finally {
    f.close();
  }
});

test('T01/T02 emotion and brevity do not classify intent, approve actions or hide tools', () => {
  const f = new Fixture();
  try {
    const mixed = f.store.runtime.begin(
        '别给我做学习计划，我今天就是很烦。顺手把明天九点的小组会记到我的安排里。',
        't01',
        't01-session',
        new AbortController().signal,
      ),
      fragments = mixed.ingress.requestFragments;
    assert.equal(mixed.ingress.contract.interpretation?.directLocalWrite, false);
    assert.deepEqual(fragments, []);
    const names = f.store.runtime.toolSpecs(mixed).map((spec) => spec.function.name);
    assert.ok(names.includes('prepare_action'));
    assert.ok(names.includes('update_work_state'));

    const rant = f.store.runtime.begin(
      '今天真的很烦，你先听我说，不要给建议。',
      't02',
      't02-session',
      new AbortController().signal,
    );
    const rantNames = f.store.runtime.toolSpecs(rant).map((spec) => spec.function.name);
    assert.deepEqual(rantNames, names);
    assert.equal(f.store.agenda().length, 0);
  } finally {
    f.close();
  }
});

test('T03/T04 subject and world fragments cannot leak account reads or mutate reality', () => {
  const f = new Fixture();
  try {
    const other = f.store.runtime.begin(
      '替室友比较一下：假如他搬到乙校区，会不会省通勤？现在还没决定。',
      't03',
      't03-session',
      new AbortController().signal,
      { semantic: controlProposal({ subject: 'other', world: 'hypothetical' }) },
    );
    assert.match(other.ingress.contract.subjectId, /^other:/);
    assert.match(other.ingress.contract.worldId, /^scenario:/);
    assert.ok(!f.policy.validate(other.ingress.contract.scope).grants.includes('campus:read'));
    assert.ok(f.store.runtime.toolSpecs(other).some((spec) => spec.function.name === 'look_up'), 'non-sensitive discovery remains visible');

    const mixed = f.store.runtime.begin(
      '替室友比较一下：假如他搬到乙校区，会不会省通勤？现在还没决定。另外，把我明晚七点的线上讨论记一下。',
      't04',
      't04-session',
      new AbortController().signal,
      { semantic: controlProposal({ subject: 'mixed', world: 'mixed' }) },
    );
    assert.equal(mixed.ingress.contract.subjectId, f.repo.identity.principalId);
    assert.equal(mixed.ingress.contract.worldId, 'real');
    assert.equal(mixed.ingress.contract.interpretation?.directLocalWrite, false);
    assert.equal(mixed.ingress.requiresReadPurpose, true);
    assert.ok(f.store.runtime.toolSpecs(mixed).some((spec) => spec.function.name === 'prepare_action'));
  } finally {
    f.close();
  }
});

test('宿主采用受众控制提案后只向草稿投影允许披露的事实', async () => {
  const f = new Fixture();
  try {
    const run = f.store.runtime.begin(
      '我这次不参加活动了，原因是家里的私事，不想让群里知道。帮我写一句自然的话。',
      'group-language',
      'group-language-session',
      new AbortController().signal,
      { semantic: controlProposal({ audience: 'group', release: { purpose: '婉拒活动', recipient: '群成员', allowedFacts: ['这次不参加活动'], tone: '自然的一句话', useAvailability: false } }) },
    );
    const pack = await f.store.runtime.compile(run, false);
    assert.equal(run.ingress.contract.audience, 'group');
    const release = JSON.stringify(pack.data.releaseSpec);
    assert.match(release, /不参加/);
    assert.doesNotMatch(release, /家里的私事/);
  } finally {
    f.close();
  }
});

test('简短输出要求不剥夺模型调查和维护复杂事项的能力', () => {
  const f = new Fixture();
  try {
    const run = f.store.runtime.begin(
      '我有点怕明天的考试，先陪我想第一步，别讲大道理。',
      'simple-step',
      'simple-step-session',
      new AbortController().signal,
    );
    const names = f.store.runtime.toolSpecs(run).map((spec) => spec.function.name);
    assert.ok(names.includes('update_work_state'));
    assert.ok(names.includes('set_plan'));
  } finally {
    f.close();
  }
});

test('标明不公开的私人细节不会进入普通长期理解', async () => {
  const f = new Fixture();
  try {
    const event = f.ingest('我最近减少活动是为了照顾家里的事情，这个原因不想公开。');
    const change = f.change(event, {
      predicate: 'activity.reason',
      value: { type: 'text', value: '家里的事情' },
      text: '用户减少活动是因为家里的事情。',
      kind: 'explicit_preference',
    });
    await assert.rejects(
      f.memory.propose(f.scope(), change, undefined, { review: { ...supported, retention: 'restricted' } }),
      /普通长期理解/,
    );
  } finally {
    f.close();
  }
});
