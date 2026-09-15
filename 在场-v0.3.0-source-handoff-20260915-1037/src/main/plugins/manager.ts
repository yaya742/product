import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import type { InstalledPlugin, PluginLifecycle } from '../../shared/plugins';
import type { InterfaceTrust } from '../../shared/interfaces';
import type {
  CapabilityDefinition,
  CapabilityJsonSchema,
  CapabilityManifest,
  CapabilityProvider,
  InvocationContext,
} from '../capabilities/broker';

const pluginId = /^[a-zA-Z0-9_.:-]{1,100}$/;
const relativeEntry = /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_RESPONSE_BYTES = 512 * 1024;

const pluginJsonSchema = z
  .record(z.string(), z.json())
  .superRefine((value, ctx) => {
    if (value.type !== undefined && typeof value.type !== 'string' && !Array.isArray(value.type))
      ctx.addIssue({ code: 'custom', message: 'JSON Schema 的 type 必须是字符串或字符串数组。' });
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((item) => typeof item !== 'string')))
      ctx.addIssue({ code: 'custom', message: 'JSON Schema 的 required 必须是字符串数组。' });
    if (value.properties !== undefined && (typeof value.properties !== 'object' || value.properties === null || Array.isArray(value.properties)))
      ctx.addIssue({ code: 'custom', message: 'JSON Schema 的 properties 必须是对象。' });
  });

const pluginCapabilitySchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/),
    displayName: z.string().min(1).max(120),
    description: z.string().max(1000),
    version: z.string().regex(versionPattern),
    effect: z.enum(['read', 'local_write', 'external_write']),
    requiredScopes: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/)).max(12),
    subjects: z
      .array(z.enum(['self', 'other', 'fictional']))
      .min(1)
      .max(3),
    worlds: z
      .array(z.enum(['real', 'scenario']))
      .min(1)
      .max(2),
    timeoutMs: z.number().int().min(100).max(90_000),
    maxBytes: z.number().int().min(1).max(150_000),
    supportsIdempotency: z.boolean(),
    supportsInspect: z.boolean(),
    supportsCancel: z.boolean(),
    inputSchema: pluginJsonSchema.optional(),
    outputSchema: pluginJsonSchema.optional(),
  })
  .strict();

export const pluginManifestSchema = z
  .object({
    apiVersion: z.literal(1),
    id: z.string().regex(pluginId),
    version: z.string().regex(versionPattern),
    displayName: z.string().min(1).max(120),
    description: z.string().max(2000),
    entry: z.string().regex(relativeEntry),
    capabilities: z.array(pluginCapabilitySchema).min(1).max(32),
    egressHosts: z.array(z.string().regex(/^(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+(?::\d+)?$/)).max(32),
    platforms: z
      .array(z.string().regex(/^[a-zA-Z0-9_*.-]{1,30}$/))
      .min(1)
      .max(8),
    offline: z.enum(['read_cache', 'unsupported']),
    license: z.string().min(1).max(120),
  })
  .strict()
  .superRefine((value, ctx) => {
    const names = new Set<string>();
    for (const capability of value.capabilities) {
      if (names.has(capability.name))
        ctx.addIssue({ code: 'custom', path: ['capabilities'], message: '能力名称不能重复。' });
      names.add(capability.name);
      if (capability.effect !== 'read' && capability.worlds.includes('scenario'))
        ctx.addIssue({ code: 'custom', path: ['capabilities'], message: '假设世界不能声明副作用能力。' });
    }
  });

type PluginManifestInput = z.infer<typeof pluginManifestSchema>;
interface RegistryRecord {
  id: string;
  displayName: string;
  description: string;
  installedAt: string;
  activeVersion?: string;
  versions: string[];
  /** The last known-good version, used to recover from a bad upgrade. */
  previousActiveVersion?: string;
  pending?: { kind: 'install' | 'upgrade' | 'uninstall'; version?: string; previousVersion?: string };
}
interface RegistryFile {
  version: 1;
  plugins: Record<string, RegistryRecord>;
}
interface PluginHost {
  register(
    provider: CapabilityProvider,
    approval: { reviewed: boolean; source: string; allowUntrustedDisabled?: boolean },
  ): void;
  unregister(id: string): void;
  providerSnapshots(): { id: string; enabled: boolean }[];
}

export interface PluginManagerOptions {
  root?: string;
  runnerPath?: string;
  executable?: string;
}

export function comparePluginVersions(left: string, right: string): number {
  const a = left.split('-', 2),
    b = right.split('-', 2);
  const an = a[0].split('.').map(Number),
    bn = b[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((an[i] || 0) !== (bn[i] || 0)) return (an[i] || 0) > (bn[i] || 0) ? 1 : -1;
  }
  if (!a[1] && b[1]) return 1;
  if (a[1] && !b[1]) return -1;
  return (a[1] || '').localeCompare(b[1] || '');
}

function safePath(value: string) {
  const normalized = value.replaceAll('\\', '/');
  return (
    !!normalized &&
    !normalized.startsWith('/') &&
    !/^[a-zA-Z]:/.test(normalized) &&
    !normalized.split('/').some((part) => part === '..' || part === '.')
  );
}

function jsonSchemaValidator(schema: unknown, label: string): z.ZodType {
  return z.unknown().superRefine((value, ctx) => {
    const issues: string[] = [];
    validateJsonSchema(value, schema, '$', issues);
    for (const message of issues.slice(0, 8)) ctx.addIssue({ code: 'custom', message: `${label}${message}` });
  });
}

/** Small, bounded JSON-Schema subset for plugin/Agent contracts. */
function validateJsonSchema(value: unknown, schema: unknown, pathName: string, issues: string[], depth = 0): void {
  if (issues.length >= 8 || depth > 16 || !schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const rule = schema as Record<string, any>;
  const type = rule.type;
  const matches = (kind: string) => {
    if (kind === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
    if (kind === 'array') return Array.isArray(value);
    if (kind === 'null') return value === null;
    if (kind === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (kind === 'string') return typeof value === 'string';
    if (kind === 'boolean') return typeof value === 'boolean';
    return true;
  };
  if (Array.isArray(type) ? !type.some(matches) : typeof type === 'string' && !matches(type)) {
    issues.push(`${pathName} 类型不符合插件声明。`);
    return;
  }
  if (Array.isArray(rule.enum) && !rule.enum.some((item: unknown) => JSON.stringify(item) === JSON.stringify(value))) {
    issues.push(`${pathName} 不在插件声明的可选值中。`);
    return;
  }
  if ('const' in rule && JSON.stringify(rule.const) !== JSON.stringify(value)) issues.push(`${pathName} 不符合插件声明的固定值。`);
  if (typeof value === 'string') {
    if (Number.isInteger(rule.minLength) && value.length < rule.minLength) issues.push(`${pathName} 长度过短。`);
    if (Number.isInteger(rule.maxLength) && value.length > rule.maxLength) issues.push(`${pathName} 长度过长。`);
  }
  if (typeof value === 'number') {
    if (typeof rule.minimum === 'number' && value < rule.minimum) issues.push(`${pathName} 小于最小值。`);
    if (typeof rule.maximum === 'number' && value > rule.maximum) issues.push(`${pathName} 大于最大值。`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(rule.minItems) && value.length < rule.minItems) issues.push(`${pathName} 项数过少。`);
    if (Number.isInteger(rule.maxItems) && value.length > rule.maxItems) issues.push(`${pathName} 项数过多。`);
    if (rule.items) value.slice(0, 256).forEach((item, index) => validateJsonSchema(item, rule.items, `${pathName}[${index}]`, issues, depth + 1));
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const properties = rule.properties && typeof rule.properties === 'object' ? rule.properties as Record<string, unknown> : {};
    for (const key of Array.isArray(rule.required) ? rule.required : [])
      if (typeof key === 'string' && !(key in objectValue)) issues.push(`${pathName}.${key} 是必填参数。`);
    for (const [key, item] of Object.entries(objectValue)) {
      if (key in properties) validateJsonSchema(item, properties[key], `${pathName}.${key}`, issues, depth + 1);
      else if (rule.additionalProperties === false) issues.push(`${pathName}.${key} 不是插件声明的参数。`);
      else if (rule.additionalProperties && typeof rule.additionalProperties === 'object') validateJsonSchema(item, rule.additionalProperties, `${pathName}.${key}`, issues, depth + 1);
    }
  }
  for (const alternative of Array.isArray(rule.allOf) ? rule.allOf : []) validateJsonSchema(value, alternative, pathName, issues, depth + 1);
  if (Array.isArray(rule.anyOf) && !rule.anyOf.some((alternative: unknown) => { const nested: string[] = []; validateJsonSchema(value, alternative, pathName, nested, depth + 1); return nested.length === 0; })) issues.push(`${pathName} 不符合插件声明的任一参数分支。`);
}

function manifestToCapabilityManifest(input: PluginManifestInput): CapabilityManifest {
  return {
    id: input.id,
    version: input.version,
    displayName: input.displayName,
    description: input.description,
    trust: 'untrusted_disabled',
    sourceId: 'plugin:' + input.id,
    capabilities: input.capabilities.map((capability): CapabilityDefinition => {
      const { inputSchema, outputSchema, ...declared } = capability;
      return {
        ...declared,
        ...(inputSchema ? { inputSchema: inputSchema as CapabilityJsonSchema } : {}),
        ...(outputSchema ? { outputSchema: outputSchema as CapabilityJsonSchema } : {}),
        input: inputSchema ? jsonSchemaValidator(inputSchema, '输入参数') : z.unknown(),
        output: outputSchema ? jsonSchemaValidator(outputSchema, '输出数据') : z.unknown(),
      };
    }),
    egressHosts: [...input.egressHosts],
    platforms: [...input.platforms],
    simulated: false,
    offline: input.offline,
    license: input.license,
  };
}

function readManifest(file: string): PluginManifestInput {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('插件缺少有效的 plugin.json。');
  }
  const parsed = pluginManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error('插件清单格式不符合在场插件规范。');
  if (!safePath(parsed.data.entry)) throw new Error('插件入口路径不安全。');
  if (!existsSync(path.join(path.dirname(file), parsed.data.entry))) throw new Error('插件入口文件不存在。');
  return parsed.data;
}

function zipEntries(buffer: Buffer): Map<string, Buffer> {
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error('插件包过大，不能超过 32 MB。');
  const start = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('这不是有效的 ZIP 插件包。');
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count > MAX_FILES || directoryOffset + directorySize > buffer.length)
    throw new Error('插件包目录无效。');
  const files = new Map<string, Buffer>();
  let cursor = directoryOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('插件包目录损坏。');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8')
      .replaceAll('\\', '/');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!safePath(name) || name.endsWith('/') || files.has(name) || (flags & 1) !== 0)
      throw new Error('插件包包含不安全或重复的文件路径。');
    if (uncompressedSize > MAX_FILE_BYTES || total + uncompressedSize > MAX_UNPACKED_BYTES)
      throw new Error('插件解压后过大。');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('插件包文件头无效。');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error('插件包文件内容不完整。');
    const compressed = buffer.subarray(dataStart, dataEnd);
    let value: Buffer;
    if (method === 0) value = Buffer.from(compressed);
    else if (method === 8) value = inflateRawSync(compressed);
    else throw new Error('插件包使用了不支持的压缩方式。');
    if (value.length !== uncompressedSize) throw new Error('插件包解压大小校验失败。');
    total += value.length;
    files.set(name, value);
  }
  if (!files.has('plugin.json')) throw new Error('插件包根目录必须包含 plugin.json。');
  return files;
}

export function inspectPluginArchive(file: string): PluginManifestInput {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error('插件包不存在。');
  const files = zipEntries(readFileSync(file));
  const manifestValue = JSON.parse(
    files
      .get('plugin.json')!
      .toString('utf8')
      .replace(/^\uFEFF/, ''),
  );
  const parsed = pluginManifestSchema.safeParse(manifestValue);
  if (!parsed.success || !safePath(parsed.data.entry) || !files.has(parsed.data.entry))
    throw new Error('插件包清单或入口文件无效。');
  return parsed.data;
}

function emptyRegistry(): RegistryFile {
  return { version: 1, plugins: {} };
}

function safeReadRegistry(file: string): RegistryFile {
  if (!existsSync(file)) return emptyRegistry();
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as RegistryFile;
    if (value?.version !== 1 || !value.plugins || typeof value.plugins !== 'object') throw new Error();
    return value;
  } catch {
    throw new Error('插件注册表损坏，请先备份用户目录后再修复。');
  }
}

function pluginDirectory(root: string, id: string, version: string) {
  const target = path.resolve(root, id, version);
  const base = path.resolve(root) + path.sep;
  if (!target.startsWith(base)) throw new Error('插件路径越界。');
  return target;
}

export class ExternalPluginProvider implements CapabilityProvider {
  readonly manifest: CapabilityManifest;
  private child?: ChildProcessWithoutNullStreams;
  private reader?: ReadlineInterface;
  private starting?: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(reason: unknown): void }>();
  private calls = new Map<string, InvocationContext>();

  constructor(
    input: PluginManifestInput,
    private readonly packageDirectory: string,
    private readonly entryName: string,
    private readonly runnerPath: string,
    private readonly executable = process.execPath,
  ) {
    this.manifest = manifestToCapabilityManifest(input);
  }

  connectionStatus() {
    return { connected: true, entry: '独立插件进程（首次调用时启动）' };
  }

  invoke(name: string, args: unknown, context: InvocationContext) {
    return this.call('invoke', name, args, context);
  }

  inspect(name: string, key: string, context: InvocationContext) {
    return this.call('inspect', name, key, context);
  }

  cancel(name: string, key: string, context: InvocationContext) {
    return this.call('cancel', name, key, context);
  }

  close(): Promise<void> {
    const child = this.child;
    const exited =
      !child || child.exitCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            child.once('exit', () => resolve());
            setTimeout(resolve, 1000);
          });
    this.stop(new Error('插件进程已关闭。'));
    return exited;
  }

  private async call(
    method: 'invoke' | 'inspect' | 'cancel',
    name: string,
    value: unknown,
    context: InvocationContext,
  ) {
    await this.ensureStarted();
    const callId = randomUUID();
    this.calls.set(callId, context);
    try {
      return await this.send(
        method,
        {
          callId,
          name,
          ...(method === 'invoke' ? { args: value } : { key: value }),
          deadline: context.deadline,
          idempotencyKey: context.idempotencyKey,
        },
        context.signal,
      );
    } finally {
      this.calls.delete(callId);
    }
  }

  private async ensureStarted() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const child = spawn(
        this.executable,
        [this.runnerPath, this.packageDirectory + '/plugin.json', this.entryName],
        {
          cwd: this.packageDirectory,
          env: pluginEnvironment(),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      this.child = child;
      child.stderr.resume();
      child.on('error', (error) => this.stop(error));
      child.on('exit', () => this.stop(new Error('插件进程已结束。')));
      this.reader = createInterface({ input: child.stdout });
      this.reader.on('line', (line) => this.receive(line));
      await this.send('initialize', { manifest: this.manifest }, undefined);
    })();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private send(method: string, params: unknown, signal: AbortSignal | undefined) {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(new Error('插件进程不可用。'));
    const id = ++this.nextId;
    return new Promise<any>((resolve, reject) => {
      const abort = () => {
        cleanup();
        this.stop(new Error('插件调用已取消。'));
        reject(signal?.reason || new Error('插件调用已取消。'));
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (reason) => {
          cleanup();
          reject(reason);
        },
      });
      if (signal?.aborted) return abort();
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) {
          this.pending.delete(id);
          cleanup();
          reject(error);
        }
      });
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private receive(line: string) {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === 'request') {
      const params = message.params || {},
        context = this.calls.get(String(params.callId));
      if (!context) return this.reply(message.id, undefined, '插件请求已失效。');
      void context
        .request(String(params.url), params.init || {})
        .then(async (response) => {
          const body = await response.text();
          if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('插件网络响应过大。');
          this.reply(message.id, {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body,
          });
        })
        .catch((error) =>
          this.reply(message.id, undefined, error instanceof Error ? error.message : '插件网络请求失败。'),
        );
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    if (message.error) pending.reject(new Error(String(message.error.message || '插件执行失败。')));
    else pending.resolve(message.result);
  }

  private reply(id: unknown, result: unknown, error?: string) {
    if (!this.child || id === undefined) return;
    this.child.stdin.write(
      JSON.stringify({ id, ...(error ? { error: { message: error } } : { result }) }) + '\n',
    );
  }

  private stop(reason: unknown) {
    this.reader?.close();
    this.reader = undefined;
    const child = this.child;
    this.child = undefined;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    this.calls.clear();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export class PluginManager {
  private readonly root?: string;
  private readonly registryPath?: string;
  private readonly runnerPath: string;
  private readonly executable: string;
  private registry: RegistryFile;
  private runtimeProviders = new Map<string, ExternalPluginProvider>();
  private runtimeErrors = new Map<string, string>();

  constructor(
    private readonly broker: PluginHost,
    options: PluginManagerOptions = {},
  ) {
    this.root = options.root;
    this.runnerPath = options.runnerPath || path.join(process.cwd(), 'dist-electron', 'plugin-runner.cjs');
    this.executable = options.executable || process.execPath;
    if (!this.root) {
      this.registry = emptyRegistry();
      return;
    }
    mkdirSync(this.root, { recursive: true });
    this.registryPath = path.join(this.root, 'registry.json');
    this.registry = safeReadRegistry(this.registryPath);
    this.applyPendingChanges();
    this.loadActive();
  }

  list(): InstalledPlugin[] {
    if (!this.root) return [];
    return Object.values(this.registry.plugins).map((record) => {
      const pending = record.pending;
      const version = pending?.version || record.activeVersion || record.versions.at(-1) || '0.0.0';
      const manifest = this.manifestFor(record.id, version);
      const snapshot = this.broker.providerSnapshots().find((item) => item.id === record.id);
      const lifecycle: PluginLifecycle = pending
        ? pending.kind === 'install'
          ? 'pending_install'
          : pending.kind === 'upgrade'
            ? 'pending_upgrade'
            : 'pending_uninstall'
        : this.runtimeErrors.has(record.id)
          ? 'invalid'
          : 'active';
      return {
        id: record.id,
        displayName: manifest?.displayName || record.displayName,
        description: manifest?.description || record.description,
        version,
        activeVersion: record.activeVersion,
        pendingVersion: pending?.version,
        trust: 'untrusted_disabled' as InterfaceTrust,
        lifecycle,
        enabled: !!snapshot?.enabled,
        installedAt: record.installedAt,
        error: this.runtimeErrors.get(record.id),
      };
    });
  }

  installFromArchive(file: string, expectedId?: string) {
    if (!this.root) throw new Error('当前运行环境没有可用的插件目录。');
    const input = inspectPluginArchive(file);
    if (expectedId && input.id !== expectedId) throw new Error('所选插件包与要升级的接口不一致。');
    const previous = this.registry.plugins[input.id];
    if (previous?.pending?.kind === 'uninstall') throw new Error('该插件正在等待卸载，请重启在场后再安装。');
    const highest = [...(previous?.versions || []), previous?.pending?.version || '0.0.0']
      .sort(comparePluginVersions)
      .at(-1);
    if (highest && comparePluginVersions(input.version, highest) <= 0)
      throw new Error(`插件版本必须高于当前版本 v${highest}。`);
    const files = zipEntries(readFileSync(file));
    const stage = path.join(this.root, '.staging-' + randomUUID());
    const target = pluginDirectory(this.root, input.id, input.version);
    try {
      mkdirSync(stage, { recursive: true });
      for (const [name, content] of files) {
        const destination = path.join(stage, name);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, content, { mode: 0o600 });
      }
      if (existsSync(target)) throw new Error('该插件版本已存在。');
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(stage, target);
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      throw error;
    }
    const record: RegistryRecord = previous || {
      id: input.id,
      displayName: input.displayName,
      description: input.description,
      installedAt: new Date().toISOString(),
      versions: [],
    };
    record.displayName = input.displayName;
    record.description = input.description;
    record.versions = [...new Set([...record.versions, input.version])].sort(comparePluginVersions);
    record.pending = {
      kind: record.activeVersion ? 'upgrade' : 'install',
      version: input.version,
      previousVersion: record.activeVersion,
    };
    this.registry.plugins[input.id] = record;
    this.writeRegistry();
  }

  uninstall(id: string) {
    if (!this.root || !this.registry.plugins[id]) throw new Error('插件不存在。');
    const record = this.registry.plugins[id];
    if (record.pending?.kind === 'uninstall') return;
    record.pending = { kind: 'uninstall', version: record.activeVersion || record.versions.at(-1) };
    this.writeRegistry();
  }

  async close() {
    await Promise.all([...this.runtimeProviders.values()].map((provider) => provider.close()));
  }

  private applyPendingChanges() {
    if (!this.root) return;
    let changed = false;
    for (const record of Object.values(this.registry.plugins)) {
      const pending = record.pending;
      if (!pending) continue;
      if (pending.kind === 'uninstall') {
        rmSync(path.join(this.root, record.id), { recursive: true, force: true });
        delete this.registry.plugins[record.id];
        changed = true;
        continue;
      }
      if (
        pending.version &&
        record.versions.includes(pending.version) &&
        existsSync(pluginDirectory(this.root, record.id, pending.version))
      ) {
        if (pending.kind === 'upgrade') record.previousActiveVersion = pending.previousVersion || record.activeVersion;
        record.activeVersion = pending.version;
        record.pending = undefined;
        changed = true;
      }
    }
    if (changed) this.writeRegistry();
  }

  private loadActive() {
    if (!this.root) return;
    for (const record of Object.values(this.registry.plugins)) {
      if (!record.activeVersion) continue;
      try {
        this.loadProvider(record);
        if (record.previousActiveVersion) {
          record.previousActiveVersion = undefined;
          this.writeRegistry();
        }
      } catch (error) {
        this.runtimeErrors.set(record.id, error instanceof Error ? error.message : '插件加载失败。');
        const fallback = record.previousActiveVersion;
        if (!fallback || !existsSync(pluginDirectory(this.root, record.id, fallback))) continue;
        record.activeVersion = fallback;
        record.previousActiveVersion = undefined;
        try {
          this.loadProvider(record);
          this.runtimeErrors.delete(record.id);
        } catch (fallbackError) {
          this.runtimeErrors.set(record.id, fallbackError instanceof Error ? fallbackError.message : '插件回滚加载失败。');
        } finally {
          this.writeRegistry();
        }
      }
    }
  }

  private loadProvider(record: RegistryRecord) {
    if (!this.root || !record.activeVersion) throw new Error('插件没有可加载的活动版本。');
    const directory = pluginDirectory(this.root, record.id, record.activeVersion);
    const input = readManifest(path.join(directory, 'plugin.json'));
    const provider = new ExternalPluginProvider(
      input,
      directory,
      input.entry,
      this.runnerPath,
      this.executable,
    );
    this.broker.register(provider, {
      reviewed: true,
      source: 'installed-plugin',
      allowUntrustedDisabled: true,
    });
    this.runtimeProviders.set(record.id, provider);
  }

  private manifestFor(id: string, version: string) {
    if (!this.root) return undefined;
    try {
      return readManifest(path.join(pluginDirectory(this.root, id, version), 'plugin.json'));
    } catch {
      return undefined;
    }
  }

  private writeRegistry() {
    if (!this.registryPath) return;
    const temporary = this.registryPath + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(this.registry, null, 2), 'utf8');
    try {
      renameSync(temporary, this.registryPath);
    } catch {
      rmSync(this.registryPath, { force: true });
      renameSync(temporary, this.registryPath);
    }
  }
}

function pluginEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ZAICHANG_PLUGIN_PROTOCOL: '1',
    ELECTRON_RUN_AS_NODE: '1',
    LANG: 'zh_CN.UTF-8',
  };
  for (const name of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}
