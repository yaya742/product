import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

if (process.platform !== 'win32') throw new Error('This packaging target currently supports Windows only.');
const project = process.cwd(), source = path.resolve('.runtime/hermes-agent');
const lock = JSON.parse(fs.readFileSync('runtime/hermes/lock.json', 'utf8'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', windowsHide: true }).trim();
if (head !== lock.commit) throw new Error('Runtime source is not the pinned Hermes revision.');
const installed = JSON.parse(fs.readFileSync('artifacts/understanding-action/runtime/install.json', 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const patch of installed.patches) if (hash(path.join(source, patch.file)) !== patch.sha256) throw new Error('Unrecorded adapter changes: ' + patch.file);
const changedFiles = execFileSync('git', ['diff', '--name-only'], { cwd: source, encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).filter(Boolean);
if (changedFiles.some(file => !installed.patches.some(patch => patch.file === file))) throw new Error('Unreviewed changes in pinned runtime source.');
const cfg = fs.readFileSync(path.join(source, '.venv/pyvenv.cfg'), 'utf8');
const pythonHome = cfg.match(/^home\s*=\s*(.+)$/m)?.[1].trim();
if (!pythonHome || !fs.existsSync(path.join(pythonHome, 'python.exe'))) throw new Error('Known Python base runtime is missing.');
const target = path.resolve('build/runtime-staging-' + Date.now());
fs.mkdirSync(target, { recursive: true });
const pyTarget = path.join(target, '.runtime/python');
fs.mkdirSync(pyTarget, { recursive: true });
for (const entry of fs.readdirSync(pythonHome, { withFileTypes: true })) {
  if (!['Lib', 'DLLs', 'tcl', 'LICENSE.txt'].includes(entry.name) && !/\.(?:exe|dll)$/.test(entry.name)) continue;
  fs.cpSync(path.join(pythonHome, entry.name), path.join(pyTarget, entry.name), { recursive: true, filter: file => !file.split(path.sep).some(part => ['site-packages', '__pycache__', 'test', 'tests', 'idlelib', 'ensurepip'].includes(part)) });
}
const packages = path.join(source, '.venv/Lib/site-packages');
fs.cpSync(packages, path.join(pyTarget, 'Lib/site-packages'), { recursive: true, filter: file => !file.split(path.sep).includes('__pycache__') && !/\.pth$/.test(file) });
const excluded = new Set(['.git', '.venv', '__pycache__', 'node_modules', 'tests', 'tests-js', 'docs', 'website', 'ui-tui', 'web', '.github', 'apps', 'docker', 'evals', 'mcp-research-data', 'datagen-config-examples', 'screenshots', '.env']);
const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: source, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
let copiedSourceFiles = 0;
for (const relative of trackedFiles) {
  if (relative.split('/').some(part => excluded.has(part) || part.startsWith('.env'))) continue;
  const file = path.resolve(source, relative), destination = path.resolve(target, '.runtime/hermes-agent', relative);
  if (!file.startsWith(source + path.sep) || !destination.startsWith(target + path.sep)) throw new Error('Runtime source path escaped staging boundaries.');
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Runtime source symlink requires explicit packaging review: ' + relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(file, destination); copiedSourceFiles++;
}
fs.cpSync('.runtime/hermes-home/config.yaml', path.join(target, '.runtime/hermes-home/config.yaml'));
fs.cpSync('runtime/hermes', path.join(target, 'runtime/hermes'), { recursive: true, filter: file => !file.includes('__pycache__') });
fs.copyFileSync(path.join(source, 'LICENSE'), 'licenses/Hermes-MIT.txt');
fs.copyFileSync(path.join(pythonHome, 'LICENSE.txt'), 'licenses/Python-LICENSE.txt');
const info = JSON.parse(execFileSync(path.join(pyTarget, 'python.exe'), ['-I', '-B', '-c', 'import sys,json,openai,httpx; print(json.dumps({"python":sys.version,"base":sys.base_prefix,"openai":openai.__version__}))'], { cwd: target, encoding: 'utf8', windowsHide: true }));
if (!path.resolve(info.base).startsWith(path.resolve(pyTarget))) throw new Error('Staged Python unexpectedly relies on the machine installation.');
const manifest = { createdAt: new Date().toISOString(), target, lock, python: info, copiedSourceFiles, sourceSelection: 'git-tracked pinned source plus verified patches; no untracked data or environment files', sidecarSha256: hash('runtime/hermes/sidecar.py'), patches: installed.patches, dependencyLockSha256: hash(path.join(source, 'uv.lock')), containsPrivateData: false, note: 'Static interpreter, pinned source and locked libraries only. No app database, model credential or user conversation is packaged.' };
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.mkdirSync('artifacts/understanding-action/package', { recursive: true });
fs.writeFileSync('artifacts/understanding-action/package/runtime.json', JSON.stringify(manifest, null, 2));
const config = {
  ...JSON.parse(fs.readFileSync('package.json', 'utf8')).build,
  extraResources: [
    { from: target, to: 'hermes-runtime', filter: ['**/*', '**/.*', '**/.*/**'] },
    { from: 'integrations/zju-student-info', to: 'integrations/zju-student-info', filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc'] },
  ],
};
fs.writeFileSync('build/hermes-builder.json', JSON.stringify(config, null, 2));
console.log(JSON.stringify({ staged: target, python: info.python, packageConfig: 'build/hermes-builder.json' }));
