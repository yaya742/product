import test from 'node:test';
import assert from 'node:assert/strict';
import { expandAgenda, normalizeCalendarInput } from '../../src/main/actions/calendar';
import type { Action } from '../../src/shared/types';
import { Fixture } from './support';
import { availableIntervals } from '../../src/main/actions/availability';

test('weekly recurrence uses its own time zone and a one-off change leaves other weeks intact', () => {
  const item: Action = { id: 'series', title: '读书会', detail: '', kind: 'event', timeZone: 'Asia/Shanghai', startsAt: '2026-09-07T01:00:00Z', durationMinutes: 30, recurrence: { frequency: 'weekly', interval: 1, count: 3 }, exceptions: [{ onDate: '2026-09-14', startsAt: '2026-09-14T03:00:00Z' }] };
  const expanded = expandAgenda([item], '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z', 'America/New_York');
  assert.equal(expanded.items.length, 3);
  assert.deepEqual(expanded.items.map(x => x.startsAt), ['2026-09-07T01:00:00.000Z', '2026-09-14T03:00:00Z', '2026-09-21T01:00:00.000Z']);
  assert.equal(item.startsAt, '2026-09-07T01:00:00Z');
});

test('DST repeats surface uncertainty and an explicit instant resolves only that instance', () => {
  const item: Action = { id: 'dst', title: '例会', detail: '', kind: 'event', timeZone: 'America/New_York', startsAt: '2026-10-25T05:30:00Z', recurrence: { frequency: 'weekly', interval: 1, count: 2 } };
  const result = expandAgenda([item], '2026-10-24T00:00:00Z', '2026-11-03T00:00:00Z', 'Asia/Shanghai');
  assert.equal(result.status, 'partial'); assert.equal(result.issues[0].status, 'ambiguous');
  const resolved = expandAgenda([{ ...item, exceptions: [{ onDate: '2026-11-01', startsAt: '2026-11-01T06:30:00Z' }] }], '2026-10-24T00:00:00Z', '2026-11-03T00:00:00Z', 'UTC');
  assert.equal(resolved.items.length, 2); assert.equal(resolved.issues.length, 0);
});

test('all-day dates survive a 23-hour DST day and unknown event ends are not reported as free time', () => {
  const allDay: Action = { id: 'all-day', title: '全天事项', detail: '', kind: 'event', allDayDate: '2026-03-08', timeZone: 'America/New_York' };
  const result = expandAgenda([allDay], '2026-03-08T00:00:00Z', '2026-03-10T00:00:00Z', 'UTC');
  const bounds = result.items[0].dateBounds as any;
  assert.equal(result.items[0].allDayDate, '2026-03-08'); assert.equal(Date.parse(bounds.to) - Date.parse(bounds.from), 23 * 3600000);
  const point: Action = { id: 'point', title: '碰头', detail: '', kind: 'event', startsAt: '2026-09-14T01:00:00Z', timeZone: 'Asia/Shanghai' };
  const later = expandAgenda([point], '2026-09-14T02:00:00Z', '2026-09-14T03:00:00Z', 'UTC');
  assert.equal(later.status, 'partial'); assert.equal(later.issues[0].status, 'unknown_end');
});

test('invalid recurrence instances and time blocks without duration fail before storage', () => {
  assert.throws(() => normalizeCalendarInput({ title: '块', detail: '', kind: 'time_block', startsAt: '2026-09-14T01:00:00Z' }, 'Asia/Shanghai'), /时长/);
  assert.throws(() => normalizeCalendarInput({ title: '会', detail: '', startsAt: '2026-09-14T01:00:00Z', recurrence: { frequency: 'weekly', interval: 1, count: 2 }, exceptions: [{ onDate: '2026-09-28', cancelled: true }] }, 'Asia/Shanghai'), /次数/);
});

test('new event registration and an explicit reminder have separate scheduling effects', () => {
  const f = new Fixture();
  try {
    f.store.saveAction({ id: 'event', title: '只登记', detail: '', kind: 'event', startsAt: '2026-09-15T01:00:00Z' });
    f.store.saveAction({ id: 'reminder', title: '提醒', detail: '', kind: 'reminder', startsAt: '2026-09-15T02:00:00Z' });
    const rows = f.repo.db.prepare("SELECT object_id FROM h_jobs WHERE kind='reminder' AND status='queued'").all();
    assert.deepEqual(rows.map(row => row.object_id), ['reminder']);
  } finally { f.close(); }
});

test('one occurrence changes through the real action transaction, and undo restores only that object', async () => {
  const f = new Fixture();
  try {
    const r = f.store.runtime, scope = f.scope();
    await r.actions.directLocal(scope, { id: 'weekly-series', capability: 'local.agenda.save', arguments: { title: '周会', detail: '', kind: 'event', timeZone: 'Asia/Shanghai', startsAt: '2026-09-07T01:00:00Z', durationMinutes: 30, recurrence: { frequency: 'weekly', interval: 1, count: 3 } }, authorized: true });
    f.store.saveAction({ id: 'untouched', title: '独立安排', detail: '', startsAt: '2026-09-16T03:00:00Z', revision: 1 });
    const run = r.begin('把9月14日这次周会改到十一点，其他周不动。', 'one-occurrence', 'calendar-change', new AbortController().signal);
    const response: any = await r.executeTool(run, 'change_local_action', { operation: 'change_occurrence', targetId: 'weekly-series', expectedRevision: 1, occurrenceDate: '2026-09-14', changes: { startsAt: '2026-09-14T03:00:00Z' } }, {
      step() {}, plan() {}, action() {}, changed() {}, delegate: async () => [],
      verifyLocalDelegation: async () => ({ decision: 'execute_local', basis: [{ id: 'one-occurrence', quote: run.ingress.authoredText }], missing: [], reason: 'Host mechanism fixture.' }),
    });
    assert.equal(response.receipt.externalRecordId, 'weekly-series');
    assert.equal(response.item.revision, 2);
    const expanded = expandAgenda([r.calendar.read('weekly-series')!], '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z', 'UTC');
    assert.deepEqual(expanded.items.map(item => item.startsAt), ['2026-09-07T01:00:00.000Z', '2026-09-14T03:00:00Z', '2026-09-21T01:00:00.000Z']);
    await r.actions.cancel(scope, response.actionId);
    assert.equal(r.calendar.read('weekly-series')!.exceptions, undefined);
    assert.equal(r.calendar.read('weekly-series')!.revision, 3);
    await r.actions.cancel(scope, response.actionId);
    assert.equal(r.calendar.read('weekly-series')!.revision, 3);
    assert.equal(r.calendar.read('untouched')!.revision, 1);
  } finally { f.close(); }
});

test('stale undo cannot overwrite a later user edit or cancel its reminder', async () => {
  const f = new Fixture();
  try {
    const r = f.store.runtime, scope = f.scope();
    await r.actions.directLocal(scope, { id: 'remind-edit', capability: 'local.agenda.save', arguments: { title: '提醒', detail: '', kind: 'reminder', startsAt: '2026-09-15T01:00:00Z' }, authorized: true });
    const first = await r.changeLocalFromUI({ ...r.calendar.read('remind-edit')!, detail: '先修改' }, 'update');
    await r.changeLocalFromUI({ ...r.calendar.read('remind-edit')!, title: '用户后来改的标题' }, 'update');
    await assert.rejects(r.actions.cancel(scope, first.actionId), /再次变化/);
    assert.equal(r.calendar.read('remind-edit')!.title, '用户后来改的标题');
    assert.equal(f.repo.db.prepare("SELECT count(*) AS n FROM h_jobs WHERE object_id='remind-edit' AND status='queued'").get()!.n, 1);
  } finally { f.close(); }
});

test('delete and undo are verified against actual local state, and a write fault rolls back the calendar', async () => {
  const f = new Fixture();
  try {
    const r = f.store.runtime, scope = f.scope();
    await r.actions.directLocal(scope, { id: 'delete-test', capability: 'local.agenda.save', arguments: { title: '安排', detail: '', kind: 'event', startsAt: '2026-09-15T01:00:00Z' }, authorized: true });
    const before = r.calendar.read('delete-test')!;
    f.repo.fault = stage => { if (stage === 'after_local_write_before_receipt') throw new Error('rollback fixture'); };
    await assert.rejects(r.changeLocalFromUI({ ...before, title: '不应留下' }, 'update'), /rollback/);
    f.repo.fault = undefined;
    assert.deepEqual(r.calendar.read('delete-test'), before);
    const removed = await r.changeLocalFromUI(before, 'delete');
    assert.equal(r.calendar.read('delete-test'), undefined);
    await r.actions.cancel(scope, removed.actionId);
    assert.equal(r.calendar.read('delete-test')!.title, before.title);
  } finally { f.close(); }
});

test('forgetting traverses calendar versions and scrubs compensation snapshots', async () => {
  const f = new Fixture();
  try {
    const memory = await f.remember('我喜欢 CANARY_CALENDAR_CHAIN_725。');
    const r = f.store.runtime, scope = f.scope();
    await r.actions.directLocal(scope, { id: 'private-calendar', capability: 'local.agenda.save', arguments: { title: '相关安排', detail: 'CANARY_CALENDAR_CHAIN_725', kind: 'todo' }, dependencies: [{ consumerId: 'pending', producerId: memory.id, producerRevision: memory.revision, sensitivity: 'privacy', invalidation: 'block' }], authorized: true });
    await r.changeLocalFromUI({ ...r.calendar.read('private-calendar')!, title: '调整后的安排' }, 'update');
    f.memory.forget([memory.id]);
    assert.equal(r.calendar.read('private-calendar'), undefined);
    assert.ok(!JSON.stringify(f.repo.db.prepare('SELECT payload FROM h_actions').all()).includes('CANARY_CALENDAR_CHAIN_725'));
    assert.ok(!JSON.stringify(f.store.export()).includes('CANARY_CALENDAR_CHAIN_725'));
  } finally { f.close(); }
});

test('free-time calculation accounts for transitions and does not invent an unknown meeting end', () => {
  const base = { from: '2026-09-14T01:00:00Z', to: '2026-09-14T04:00:00Z', transitionMinutes: { min: 15, max: 25 }, minimumBlockMinutes: 45 };
  const result = availableIntervals({ ...base, busy: [{ start: '2026-09-14T02:00:00Z', end: '2026-09-14T03:00:00Z' }] });
  assert.deepEqual(result.windows.map(window => window.usableMinutes), [{ min: 35, max: 45 }, { min: 35, max: 45 }]);
  assert.ok(result.windows.every(window => window.fitsMinimum === 'uncertain'));
  const unknown = availableIntervals({ ...base, busy: [{ start: '2026-09-14T02:00:00Z', end: null }] });
  assert.equal(unknown.windows.length, 1); assert.equal(unknown.status, 'conditional');
});
