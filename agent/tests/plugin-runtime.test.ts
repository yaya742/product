import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ExternalPluginProvider } from '../src/main/plugins/manager';

test('plugin runner loads an external entry and returns host-mediated requests', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zaichang-plugin-runtime-'));
  let child: ReturnType<typeof spawn> | undefined;
  const stopChild = async () => {
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    await Promise.race([
      new Promise<void>((resolve) => child!.once('exit', () => resolve())),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          child?.kill();
          resolve();
        }, 1000),
      ),
    ]);
  };
  try {
    const manifest = path.join(root, 'plugin.json');
    const entry = path.join(root, 'index.mjs');
    writeFileSync(
      manifest,
      JSON.stringify({
        apiVersion: 1,
        id: 'demo.runner',
        version: '1.0.0',
        displayName: 'runner',
        description: '',
        entry: 'index.mjs',
        capabilities: [],
        egressHosts: [],
        platforms: ['*'],
        offline: 'unsupported',
        license: 'MIT',
      }),
    );
    writeFileSync(
      entry,
      `export default { invoke: async ({ context }) => { const response = await context.request('https://api.example.com/ping'); return { status: 'fresh', sourceId: 'plugin:demo.runner', data: await response.json(), simulated: false }; } };`,
    );
    child = spawn(process.execPath, [path.resolve('dist-electron/plugin-runner.cjs'), manifest, entry], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const reader = createInterface({ input: child.stdout });
    const frames: any[] = [];
    const next = () =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`插件 runner 未返回协议帧：${stderr}`)), 5000);
        const onLine = (line: string) => {
          clearTimeout(timer);
          reader.removeListener('line', onLine);
          try {
            resolve(JSON.parse(line));
          } catch (error) {
            reject(error);
          }
        };
        reader.on('line', onLine);
        child!.once('error', reject);
      });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {} }) + '\n');
    assert.deepEqual(await next(), { id: 1, result: { ready: true } });
    child.stdin.write(
      JSON.stringify({
        id: 2,
        method: 'invoke',
        params: {
          callId: 'call-1',
          name: 'demo.runner.lookup',
          args: {},
          deadline: new Date(Date.now() + 10000).toISOString(),
        },
      }) + '\n',
    );
    const request = await next();
    frames.push(request);
    assert.equal(request.method, 'request');
    assert.equal(request.params.url, 'https://api.example.com/ping');
    child.stdin.write(
      JSON.stringify({
        id: request.id,
        result: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
      }) + '\n',
    );
    assert.deepEqual(await next(), {
      id: 2,
      result: { status: 'fresh', sourceId: 'plugin:demo.runner', data: { ok: true }, simulated: false },
    });
    await stopChild();
    reader.close();
  } finally {
    await stopChild();
    rmSync(root, { recursive: true, force: true });
  }
});

test('external plugin provider starts through Electron Node mode on Windows', async () => {
  if (process.platform !== 'win32') return;
  const root = mkdtempSync(path.join(os.tmpdir(), 'zaichang-plugin-electron-'));
  const providerManifest = {
    apiVersion: 1,
    id: 'demo.electron',
    version: '1.0.0',
    displayName: 'Electron runner',
    description: '',
    entry: 'index.mjs',
    capabilities: [
      {
        name: 'demo.electron.lookup',
        displayName: '查询',
        description: '',
        version: '1.0.0',
        effect: 'read',
        requiredScopes: [],
        subjects: ['self'],
        worlds: ['real'],
        timeoutMs: 5000,
        maxBytes: 4000,
        supportsIdempotency: false,
        supportsInspect: false,
        supportsCancel: false,
      },
    ],
    egressHosts: [],
    platforms: ['win32'],
    offline: 'unsupported',
    license: 'MIT',
  } as any;
  try {
    writeFileSync(path.join(root, 'plugin.json'), JSON.stringify(providerManifest));
    writeFileSync(
      path.join(root, 'index.mjs'),
      "export default { invoke: async () => ({ status: 'fresh', sourceId: 'plugin:demo.electron', data: { ok: true }, simulated: false }) }",
    );
    const provider = new ExternalPluginProvider(
      providerManifest,
      root,
      'index.mjs',
      path.resolve('dist-electron/plugin-runner.cjs'),
      path.resolve('node_modules/electron/dist/electron.exe'),
    );
    const result: any = await provider.invoke(
      'demo.electron.lookup',
      {},
      {
        capability: 'demo.electron.lookup',
        deadline: new Date(Date.now() + 5000).toISOString(),
        signal: new AbortController().signal,
        scope: {} as any,
        request: async () => new Response(''),
      },
    );
    assert.equal(result.data.ok, true);
    await provider.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
