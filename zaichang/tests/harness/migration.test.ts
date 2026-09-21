import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { Fixture, testDirectory } from './support';

test('INV-09 legacy v0 backup with no kernel tables still applies source-span deletion barriers before migration', () => {
  const dir = testDirectory('legacy-barrier'),
    file = path.join(dir, 'test.sqlite'),
    backup = path.join(dir, 'legacy-v0.sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE memories(id TEXT PRIMARY KEY,text TEXT NOT NULL,quote TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,updated_at TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',summary_count INTEGER NOT NULL DEFAULT 0); CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL);",
  );
  const at = '2026-09-01T06:00:00.000Z',
    content = '我喜欢CANARY_LEGACY_V0。';
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run('legacy-session', '旧记录', at, content, 1);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(
    'legacy-source',
    'legacy-session',
    'user',
    content,
    at,
    JSON.stringify({
      id: 'legacy-source',
      sessionId: 'legacy-session',
      role: 'user',
      content,
      createdAt: at,
      status: 'done',
      steps: [],
      obligations: [],
      actions: [],
    }),
  );
  db.prepare('INSERT INTO memories VALUES(?,?,?,?)').run('legacy-memory', content, content, at);
  db.prepare('VACUUM INTO ?').run(backup);
  db.close();
  let f = new Fixture(dir);
  try {
    assert.equal(f.store.memories()[0].id, 'legacy-memory');
    f.memory.forget(['legacy-memory']);
    f.close();
    fs.copyFileSync(backup, file);
    f = new Fixture(dir);
    assert.ok(!JSON.stringify(f.store.export()).includes('CANARY_LEGACY_V0'));
    assert.equal(f.repo.getMeta('restoration_fence_applied'), true);
  } finally {
    f.close();
  }
});
test('INV-16 migration source and recovery tool leave the original backup untouched and restore into a separate disabled profile', () => {
  const f = new Fixture();
  try {
    f.store.saveMemory('我偏好明确的来源。');
    const backup = path.join(f.dir, 'before.sqlite');
    f.repo.db.prepare('VACUUM INTO ?').run(backup);
    f.policy.revoke('weather:read');
    const target = path.join(f.dir, 'restored'),
      before = fs.readFileSync(backup);
    const result = spawnSync(
      process.execPath,
      [
        'scripts/harness-recover.mjs',
        '--source',
        backup,
        '--fences',
        f.file + '.privacy-fences.json',
        '--destination',
        target,
        '--apply',
      ],
      { env: process.env, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(target, 'recovery-report.json'), 'utf8'));
    assert.equal(report.status, 'recovered_isolated');
    assert.equal(report.credentialsRestored, false);
    assert.equal(report.privacyEpoch, f.repo.epoch);
    assert.deepEqual(fs.readFileSync(backup), before);
    const repeat = spawnSync(
      process.execPath,
      [
        'scripts/harness-recover.mjs',
        '--source',
        backup,
        '--fences',
        f.file + '.privacy-fences.json',
        '--destination',
        target,
        '--apply',
      ],
      { env: process.env, encoding: 'utf8', windowsHide: true },
    );
    assert.notEqual(repeat.status, 0);
  } finally {
    f.close();
  }
});
test('INV-13 large imports and exports preserve records past the old 500-row read window', () => {
  const f = new Fixture();
  try {
    const schedule = Array.from({ length: 620 }, (_, i) => ({
      id: 'course-' + i,
      title: '合成课程 ' + i,
      startsAt: '2026-09-14T08:00:00Z',
      endsAt: '2026-09-14T09:00:00Z',
      location: '测试楼',
      status: 'scheduled' as const,
      source: 'synthetic',
    }));
    f.store.runtime.domains.importSnapshot({
      source: 'synthetic',
      updatedAt: f.clock.now(),
      schedule,
      exams: [],
      places: [],
      rules: [],
    });
    assert.equal(f.store.campus()?.schedule.length, 620);
    const exported = f.store.export();
    assert.equal(exported.domainRecords.filter((r: any) => r.domain === 'schedule').length, 620);
    assert.equal(f.repo.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    f.close();
  }
});
