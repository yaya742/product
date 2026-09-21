import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedTimeConversions } from './harness/evaluation-time';
test('UTC Z and an explicit Shanghai offset identify 14:00, including embedded tool JSON', () => {
  const evidence = { now: '2026-09-14T06:00:00.000Z', observation: JSON.stringify({ fetchedAt: '2026-09-14T14:00:00+08:00' }), localUnknown: '2026-09-14 06:00' };
  const result = verifiedTimeConversions(evidence, 'Asia/Shanghai');
  assert.equal(result.values.length, 2); assert.ok(result.values.every(row => row.local === '2026-09-14 14:00:00 GMT+08:00')); assert.equal(result.values[0].utc, result.values[1].utc);
  assert.equal(evidence.now, '2026-09-14T06:00:00.000Z');
});
test('date rollover and daylight saving offsets are calculated independently, not guessed by the judge', () => {
  const shanghai = verifiedTimeConversions({ at: '2026-09-14T20:30:00Z' }, 'Asia/Shanghai');
  assert.equal(shanghai.values[0].local, '2026-09-15 04:30:00 GMT+08:00');
  const ny = verifiedTimeConversions(['2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z'], 'America/New_York');
  assert.equal(ny.values[0].local, '2026-03-08 01:30:00 GMT-05:00'); assert.equal(ny.values[1].local, '2026-03-08 03:30:00 GMT-04:00');
});
