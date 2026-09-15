import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectPluginArchive, PluginManager } from '../src/main/plugins/manager';
import { CapabilityBroker, type CapabilityProvider } from '../src/main/capabilities/broker';

function zip(files: Record<string, string>) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name),
      value = Buffer.from(text),
      compressed = deflateRawSync(value);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(value.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(value.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

function manifest(version: string) {
  return JSON.stringify({
    apiVersion: 1,
    id: 'demo.plugin',
    version,
    displayName: '示例插件',
    description: '插件生命周期测试。',
    entry: 'index.mjs',
    capabilities: [
      {
        name: 'demo.plugin.lookup',
        displayName: '查询示例',
        description: '读取示例。',
        version,
        effect: 'read',
        requiredScopes: [],
        subjects: ['self'],
        worlds: ['real'],
        timeoutMs: 1000,
        maxBytes: 4000,
        supportsIdempotency: false,
        supportsInspect: false,
        supportsCancel: false,
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
    ],
    egressHosts: [],
    platforms: ['win32'],
    offline: 'unsupported',
    license: 'MIT',
  });
}

class Host {
  providers = new Map<string, CapabilityProvider>();
  register(provider: CapabilityProvider) {
    this.providers.set(provider.manifest.id, provider);
  }
  unregister(id: string) {
    this.providers.delete(id);
  }
  providerSnapshots() {
    return [...this.providers].map(([id]) => ({ id, enabled: false }));
  }
}

function packageFile(root: string, version: string, files: Record<string, string> = {}) {
  const file = path.join(root, `demo-${version}.zip`);
  writeFileSync(
    file,
    zip({
      'plugin.json': manifest(version),
      'index.mjs': 'export default { invoke: async () => ({}) };',
      ...files,
    }),
  );
  return file;
}

test('plugin manager stages a first install and activates it only after restart', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zaichang-plugin-'));
  try {
    const firstHost = new Host();
    const first = new PluginManager(firstHost, { root, runnerPath: 'runner' });
    first.installFromArchive(packageFile(root, '1.0.0'));
    assert.equal(first.list()[0].lifecycle, 'pending_install');
    assert.equal(firstHost.providers.size, 0);

    const secondHost = new Host();
    const second = new PluginManager(secondHost, { root, runnerPath: 'runner' });
    assert.equal(second.list()[0].lifecycle, 'active');
    assert.equal(second.list()[0].activeVersion, '1.0.0');
    assert.ok(secondHost.providers.has('demo.plugin'));
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin manager keeps the active version during upgrade and uninstall until restart', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zaichang-plugin-'));
  try {
    const host = new Host();
    const manager = new PluginManager(host, { root, runnerPath: 'runner' });
    manager.installFromArchive(packageFile(root, '1.0.0'));
    const running = new PluginManager(host, { root, runnerPath: 'runner' });
    running.installFromArchive(packageFile(root, '1.1.0'));
    assert.equal(running.list()[0].lifecycle, 'pending_upgrade');
    assert.equal(running.list()[0].activeVersion, '1.0.0');
    assert.equal(running.list()[0].pendingVersion, '1.1.0');
    running.uninstall('demo.plugin');
    assert.equal(running.list()[0].lifecycle, 'pending_uninstall');
    assert.ok(existsSync(path.join(root, 'demo.plugin', '1.0.0')));

    const restartedHost = new Host();
    const restarted = new PluginManager(restartedHost, { root, runnerPath: 'runner' });
    assert.deepEqual(restarted.list(), []);
    assert.equal(existsSync(path.join(root, 'demo.plugin')), false);
    restarted.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin manager rejects path traversal and non-increasing versions', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zaichang-plugin-'));
  try {
    const manager = new PluginManager(new Host(), { root, runnerPath: 'runner' });
    assert.throws(
      () => manager.installFromArchive(packageFile(root, '1.0.0', { '../escape.txt': 'nope' })),
      /不安全|越界/,
    );
    manager.installFromArchive(packageFile(root, '1.0.0'));
    assert.throws(() => manager.installFromArchive(packageFile(root, '1.0.0')), /必须高于/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin manager rolls back to the last known-good version after a bad upgrade', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zaichang-plugin-'));
  try {
    const first = new PluginManager(new Host(), { root, runnerPath: 'runner' });
    first.installFromArchive(packageFile(root, '1.0.0'));
    const running = new PluginManager(new Host(), { root, runnerPath: 'runner' });
    running.installFromArchive(packageFile(root, '1.1.0'));
    writeFileSync(path.join(root, 'demo.plugin', '1.1.0', 'plugin.json'), '{ invalid json');

    const host = new Host();
    const recovered = new PluginManager(host, { root, runnerPath: 'runner' });
    assert.equal(recovered.list()[0].activeVersion, '1.0.0');
    assert.equal(recovered.list()[0].lifecycle, 'active');
    assert.equal(recovered.list()[0].error, undefined);
    assert.ok(host.providers.has('demo.plugin'));
    recovered.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin archive preserves Agent-facing input and output schemas', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zaichang-plugin-'));
  try {
    const archive = packageFile(root, '1.0.0');
    const input = inspectPluginArchive(archive);
    assert.deepEqual(input.capabilities[0].inputSchema, {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    });
    assert.equal(input.capabilities[0].outputSchema?.type, 'object');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CapabilityBroker validates an external plugin contract before and after invocation', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zaichang-plugin-'));
  const now = () => new Date().toISOString();
  const policy = {
    repo: { clock: { now }, domainRevision: 0 },
    onBarrier: () => () => {},
    registerSource: () => {},
    validate: () => ({
      principalId: 'student-a', workspaceId: 'test', deviceId: 'test', subjectId: 'student-a',
      worldId: 'real', sources: ['plugin:demo.plugin'], currentEventIds: [], purposes: ['test'],
      audience: 'self', grants: [], privacyEpoch: 1, policyRevision: 1,
      retention: 'purpose_scoped', infer: false, expiresAt: new Date(Date.now() + 60000).toISOString(), child: false,
    }),
  } as any;
  const broker = new CapabilityBroker(policy);
  try {
    const packagePath = packageFile(root, '1.0.0', {
      'index.mjs': "export default { invoke: async () => ({ status: 'fresh', sourceId: 'plugin:demo.plugin', data: { ok: true }, simulated: false }) };",
    });
    const staging = new PluginManager(broker, { root, runnerPath: path.resolve('dist-electron/plugin-runner.cjs') });
    staging.installFromArchive(packagePath);
    const active = new PluginManager(broker, { root, runnerPath: path.resolve('dist-electron/plugin-runner.cjs') });
    broker.setProviderEnabled('demo.plugin', true);
    const scope = {} as any;

    const invalid = await broker.invoke(scope, 'demo.plugin.lookup', { query: 3 }, new AbortController().signal);
    assert.equal(invalid.status, 'failed');
    assert.equal(broker.rejections.at(-1)?.code, 'schema_rejected');
    const valid = await broker.invoke(scope, 'demo.plugin.lookup', { query: 'ok' }, new AbortController().signal);
    assert.equal(valid.status, 'fresh');
    assert.deepEqual(valid.data, { ok: true });
    assert.deepEqual(broker.detail(scope, 'demo.plugin.lookup').inputSchema, {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    });
    await active.close();
    await staging.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
