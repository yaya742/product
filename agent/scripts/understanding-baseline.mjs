import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Preserve the user's current checkout, including pre-existing uncommitted work.
// No application database, credentials, dependencies, or old run payloads enter it.
const root = process.cwd();
const id = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.join(root, '.test-data', 'understanding-baseline-' + id);
const report = path.join(root, 'artifacts', 'understanding-action', 'baseline');
fs.mkdirSync(destination, { recursive: true });
fs.mkdirSync(report, { recursive: true });
const roots = ['src', 'scripts', 'tests', 'prompts', 'licenses', '.agents'];
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}
for (const name of roots) if (fs.existsSync(name)) walk(name);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.(md|json|html)$/.test(entry.name)) files.push(entry.name);
  if (entry.isDirectory() && entry.name.startsWith('在场-')) walk(entry.name);
}
const manifest = files.sort().map(file => {
  const bytes = fs.readFileSync(file);
  const target = path.join(destination, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { path: file.replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const git = args => execFileSync('git', args, { encoding: 'utf8', windowsHide: true });
fs.writeFileSync(path.join(report, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), head: git(['rev-parse', 'HEAD']).trim(), snapshot: destination, files: manifest }, null, 2));
fs.writeFileSync(path.join(report, 'pre-existing-changes.txt'), git(['status', '--short']));
console.log(JSON.stringify({ snapshot: destination, fileCount: manifest.length, report }));
