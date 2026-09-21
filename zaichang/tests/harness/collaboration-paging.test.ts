import test from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './support';

test('collaboration pagination reaches every matching record beyond the former 200-row window', () => {
  const f = new Fixture();
  try {
    const scope = f.scope(), work = f.store.runtime.work, service = f.store.runtime.collaboration;
    f.repo.write(() => {
      for (let index = 0; index < 231; index++) work.create(scope, 'goal', '分页事项 ' + index, { sessionId: 'paging-session' }, { id: 'page-' + index, status: 'active' });
      for (let index = 0; index < 215; index++) work.create(scope, 'episode', '无关较新记录 ' + index, { sessionId: 'other-session' }, { status: 'active' });
    });
    const ids: string[] = []; let offset: number | null = 0;
    do {
      const page = service.restore(scope, 'paging-session', '', offset, 17);
      assert.equal(page.coverage.totalMatches, 231);
      assert.equal(page.coverage.complete, page.nextOffset === null);
      ids.push(...page.items.map(item => item.id)); offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(ids.length, 231); assert.equal(new Set(ids).size, 231);
    assert.equal(ids.at(-1), 'page-0');
    const beyond = service.restore(scope, 'paging-session', '', 999, 17);
    assert.deepEqual(beyond.items, []); assert.equal(beyond.nextOffset, null); assert.equal(beyond.coverage.totalMatches, 231);
    const restricted = f.scope({ sources: ['current'] });
    const reads = f.repo.access.length;
    assert.deepEqual(service.restore(restricted, 'paging-session', '分页事项').items, []);
    assert.equal(f.repo.access.length, reads, 'forbidden work bodies are not returned or accessed');
  } finally { f.close(); }
});

test('old frames and options can be searched, referenced and repaired by stable ID after many newer records', async () => {
  const f = new Fixture();
  try {
    const r = f.store.runtime, scope = f.scope();
    const evidence = f.ingest('保留投影演示的地点比较。', 'old-frame-origin');
    const frame = r.collaboration.update(scope, 'original-thread', { operation: 'frame', title: '投影演示 地点', source: { eventId: evidence.id, quote: evidence.text }, frame: { question: '旧事项的地点比较', confirmedFacts: [], decisions: [], tentativeUnderstanding: [], participation: ['比较'], rejectedOptions: [], nextStep: null } });
    r.work.addOptions(scope, frame.id, [{ id: 'old-option', title: '留在当前场地' }]);
    f.repo.write(() => {
      for (let i = 0; i < 225; i++) {
        r.work.create(scope, 'episode', '较新的话题 ' + i, { sessionId: 'unrelated' }, { status: 'active' });
        r.work.create(scope, 'option', '较新的选项 ' + i, {}, { status: 'candidate' });
      }
    });
    const found = r.collaboration.restore(scope, 'new-thread', '投影演示 地点');
    assert.equal(found.items.length, 1); assert.equal(found.items[0].id, frame.id);
    assert.deepEqual(found.relatedOptions.map(option => option.id), ['old-option']);
    const text = '继续保留的那个选项，只比较。';
    const run = r.begin(text, 'current-reference', 'new-thread', new AbortController().signal);
    await r.executeTool(run, 'update_work_state', { operation: 'reference_option', episodeId: frame.id, id: 'old-option', expectedRevision: found.items[0].revision, sourceQuote: text }, { step() {}, plan() {}, action() {}, changed() {}, delegate: async () => [] });
    const referenced = f.repo.work(scope, 'episode', frame.id)[0];
    assert.equal(referenced.data.referencedOptionId, 'old-option');
    const correction = f.ingest('这个地点条件需要重判。', 'old-frame-correction');
    const repaired = r.collaboration.update(scope, 'new-thread', { operation: 'repair', id: frame.id, expectedRevision: referenced.revision, source: { eventId: correction.id, quote: correction.text }, reason: '现场条件改变' });
    assert.equal(repaired.status, 'needs_review'); assert.equal(repaired.revision, referenced.revision + 1);
    const denied = f.scope({ sources: ['current'], currentEventIds: [correction.id] });
    assert.throws(() => r.collaboration.update(denied, 'new-thread', { operation: 'repair', id: frame.id, expectedRevision: repaired.revision, source: { eventId: correction.id, quote: correction.text }, reason: '无权限的修改' }), /没有找到/);
    assert.equal(f.repo.work(scope, 'episode', frame.id)[0].revision, repaired.revision);
  } finally { f.close(); }
});
