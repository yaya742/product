import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/main/store';

const args = process.argv.slice(2),
  read = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
const source = read('--source'),
  fences = read('--fences'),
  destination = read('--destination');
if (!source || !fences || !destination)
  throw new Error(
    'Usage: npm run recover:harness -- --source backup.sqlite --fences current.sqlite.privacy-fences.json --destination NEW_DIRECTORY [--apply]',
  );
const sourcePath = path.resolve(source),
  fencePath = path.resolve(fences),
  target = path.resolve(destination);
if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile() || !fs.existsSync(fencePath))
  throw new Error('Backup and latest privacy barrier files are required.');
const header = Buffer.alloc(16),
  descriptor = fs.openSync(sourcePath, 'r');
try {
  fs.readSync(descriptor, header, 0, 16, 0);
} finally {
  fs.closeSync(descriptor);
}
if (header.toString() !== 'SQLite format 3\0') throw new Error('Source is not a supported SQLite backup.');
const ledger = JSON.parse(fs.readFileSync(fencePath, 'utf8'));
if (ledger.version !== 1 || !Array.isArray(ledger.fences))
  throw new Error('Unsupported or corrupt privacy barrier.');
if (fs.existsSync(target) && fs.readdirSync(target).length)
  throw new Error(
    'Destination must be a new or empty isolated directory. Existing profiles are never overwritten.',
  );
const preview = {
  mode: args.includes('--apply') ? 'apply' : 'preview',
  source: sourcePath,
  destination: target,
  privacyFenceCount: ledger.fences.length,
  minimumEpoch: ledger.minimumEpoch || Math.max(1, ...ledger.fences.map((f: any) => f.epoch)),
  credentialsRestored: false,
  externalConnectionsEnabled: false,
};
if (!args.includes('--apply')) console.log(JSON.stringify(preview, null, 2));
else {
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, 'zaichang.sqlite');
  fs.copyFileSync(sourcePath, file);
  fs.copyFileSync(fencePath, file + '.privacy-fences.json');
  let store: Store | undefined;
  try {
    store = new Store(file);
    store.saveSettings({ mode: 'demo', remindersEnabled: false, weatherEnabled: false });
    store.db.prepare("DELETE FROM meta WHERE key LIKE 'zju_%'").run();
    store.putMeta('zju_source_disabled', true);
    store.kernel.db.prepare('DELETE FROM h_approvals').run();
    store.kernel.db
      .prepare("UPDATE h_jobs SET status='paused_restore',fence=fence+1 WHERE status IN ('queued','leased')")
      .run();
    const integrity = store.db.prepare('PRAGMA integrity_check').get();
    const foreignKeys = store.db.prepare('PRAGMA foreign_key_check').all();
    if (integrity?.integrity_check !== 'ok' || foreignKeys.length)
      throw new Error('Recovered data failed SQLite integrity/reference checks.');
    const report = {
      ...preview,
      status: 'recovered_isolated',
      schemaVersion: store.db.prepare('PRAGMA user_version').get()?.user_version,
      privacyEpoch: store.kernel.epoch,
      integrity: 'ok',
      foreignKeyViolations: 0,
      conversations: store.conversations().length,
      activation: 'Review this isolated profile. It does not replace the default application profile.',
    };
    fs.writeFileSync(path.join(target, 'recovery-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    fs.writeFileSync(
      path.join(target, 'recovery-report.json'),
      JSON.stringify(
        {
          ...preview,
          status: 'failed_quarantined',
          error: error instanceof Error ? error.message : 'Recovery failed',
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    store?.close();
  }
}
