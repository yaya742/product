import test from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './support';
import { DraftStore } from '../../src/main/storage/drafts';

test('automatic draft updates remain in memory before natural-language retention is known', () => {
  const f = new Fixture();
  try {
    const drafts = new DraftStore(f.store), value = { text: 'CANARY_DRAFT_735。这些话别落盘。', attachment: null };
    drafts.save('new', value);
    assert.deepEqual(drafts.get('new'), value);
    assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key='draft:new'").get(), undefined);
    assert.ok(!JSON.stringify(f.store.export()).includes('CANARY_DRAFT_735'));
  } finally { f.close(); }
});

test('explicitly saved drafts survive while stale or temporary draft approvals cannot write', () => {
  const f = new Fixture();
  try {
    const drafts = new DraftStore(f.store);
    drafts.save('new', { text: '明确保存的草稿', attachment: null });
    const old = drafts.info('new');
    drafts.save('new', { text: '后来改过的草稿', attachment: null });
    assert.throws(() => drafts.persist('new', old.digest), /改变/);
    drafts.persist('new', drafts.info('new').digest);
    assert.equal(new DraftStore(f.store).get('new').text, '后来改过的草稿');
    drafts.save('temp', { text: '临时内容', attachment: null }, true);
    assert.throws(() => drafts.persist('temp', drafts.info('temp').digest), /不写入/);
    const epoch = f.repo.epoch;
    f.policy.revoke('campus:read');
    assert.throws(() => drafts.save('old', { text: '旧窗口', attachment: null }, false, epoch), /旧窗口/);
  } finally { f.close(); }
});
