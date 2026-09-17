import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeImage,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store } from './store';
import { DraftStore } from './storage/drafts';
import { Harness } from './harness';
import { ZjuAdapter } from './zjuAdapter';
import { CampusMapAdapter } from './mapService';
import { MapLocationProvider } from './mapLocation';
const mapLocation = new MapLocationProvider();
// Keep map and weather requests independent so a weather lookup cannot cancel
// an in-progress map location request (or vice versa).
const weatherLocation = new MapLocationProvider();
import { friendlyError } from './provider';
import { createModelClient, usingLunaTestTransport } from './model-selection';
import { actionSchema, campusSchema, settingsSchema } from '../shared/schemas';
import { DEEPSEEK_MODEL, type Draft, type ImageAttachment, type Settings } from '../shared/types';
import campusExample from '../../examples/campus.example.json';
import { LIMITS } from '../shared/limits';
import { assertTestDataDirectory } from './testBoundary';
import { isEphemeral } from './runtime/policy';
import { conditionSchema } from '../shared/harness';
import { hasCredentials } from './runtime/redaction';
import { NativeControls } from './runtime/controls';
import type { PluginPackagePreview } from '../shared/plugins';

assertTestDataDirectory();
// The installed product owns a relocatable interpreter and pinned engine.
// Development and isolated tests can explicitly choose a runtime root.
if (app.isPackaged) process.env.ZAICHANG_RUNTIME_ROOT = path.join(process.resourcesPath, 'hermes-runtime');
else process.env.ZAICHANG_RUNTIME_ROOT ||= path.resolve(__dirname, '..');
const devServerUrl =
  process.env.ZAICHANG_DEV === '1'
    ? process.env.ZAICHANG_DEV_SERVER_URL || 'http://127.0.0.1:5173'
    : '';

// A repository command may inject the user's DPAPI-protected project credential
// for this process only. Capture it before Electron starts, then remove all model
// credentials from the inherited environment so unrelated child processes never
// receive them.
let projectDeepSeekKey = (process.env.ZAICHANG_PROJECT_DEEPSEEK_KEY || '').trim();
if (
  projectDeepSeekKey.length < 8 ||
  projectDeepSeekKey.length > 512 ||
  /\s/.test(projectDeepSeekKey)
)
  projectDeepSeekKey = '';
for (const name of [
  'ZAICHANG_PROJECT_DEEPSEEK_KEY',
  'ZAICHANG_TEST_DEEPSEEK_KEY',
  'ZAICHANG_ALLOW_LIVE_EVAL',
  'DEEPSEEK_API_KEY',
])
  delete process.env[name];

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
// Explicit profile override also makes packaged verification independent of personal data.
if (process.env.ZAICHANG_DATA_DIR) app.setPath('userData', path.resolve(process.env.ZAICHANG_DATA_DIR));
app.setName('在场');
let window: BrowserWindow | undefined,
  store: Store,
  harness: Harness,
  zju: ZjuAdapter,
  map: CampusMapAdapter,
  keyPath = '',
  invalidStoredKey = false;
let closing = false;
let connectionController: AbortController | undefined;
function credentialPaths() {
  const paths = [keyPath];
  // The source cold-start launcher historically used
  // %LOCALAPPDATA%\Zaichang\source-dev while the packaged app uses Electron's
  // %APPDATA%\在场 profile. Read either profile so changing launch modes does
  // not make a valid user credential appear to disappear. Isolated tests must
  // never read a real personal profile.
  if (process.env.ZAICHANG_TEST !== '1') {
    if (process.env.APPDATA) paths.push(path.join(process.env.APPDATA, '在场', 'deepseek-key.bin'));
    if (process.env.LOCALAPPDATA) paths.push(path.join(process.env.LOCALAPPDATA, 'Zaichang', 'source-dev', 'deepseek-key.bin'));
  }
  return [...new Set(paths.filter(Boolean))];
}
function getKey() {
  if (projectDeepSeekKey) {
    invalidStoredKey = false;
    return projectDeepSeekKey;
  }
  let foundStoredKey = false;
  for (const candidate of credentialPaths()) {
    if (!existsSync(candidate)) continue;
    foundStoredKey = true;
    try {
      const key = safeStorage.decryptString(readFileSync(candidate)).trim();
      if (!key) continue;
      invalidStoredKey = false;
      return key;
    } catch {
      // Another profile may contain the current valid credential. Continue
      // checking it before reporting the stored credential as unreadable.
    }
  }
  // Keep the app usable, but expose that this is a recoverable credential issue
  // only when every existing profile copy was unreadable.
  invalidStoredKey = foundStoredKey;
  return '';
}
function saveKey(key: string) {
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
  )
    throw new Error('系统密钥保护暂不可用，API Key 未保存。');
  writeFileSync(keyPath, safeStorage.encryptString(key), { mode: 0o600 });
  invalidStoredKey = false;
}
function deleteKey() {
  for (const candidate of credentialPaths()) if (existsSync(candidate)) unlinkSync(candidate);
  projectDeepSeekKey = '';
  invalidStoredKey = false;
}
function missingKeyError() {
  return invalidStoredKey
    ? '已保存的 DeepSeek API Key 无法读取，请打开连接设置重新输入并保存。'
    : '请先打开连接设置，填写 DeepSeek API Key 后再发送。';
}
function state() {
  const key = getKey();
  const snapshot = store.state(!!key);
  return {
    ...snapshot,
    settings: {
      ...snapshot.settings,
      keyStatus: invalidStoredKey ? 'invalid' : key ? 'available' : 'missing',
    },
    campusConnector: zju.describe(),
  };
}
function pluginPreviewDetail(preview: PluginPackagePreview) {
  const effectText = (effect: PluginPackagePreview['capabilities'][number]['effect']) => {
    if (effect === 'read') return '只读';
    if (effect === 'local_write') return '本机写入';
    return '外部写入';
  };
  const capabilities = preview.capabilities.length
    ? preview.capabilities
        .map(
          (capability) =>
            `- ${capability.displayName}（${effectText(capability.effect)}；权限：${
              capability.requiredScopes.join('、') || '无需额外权限'
            }）`,
        )
        .join('\n')
    : '- 未声明能力';
  return [
    `版本：v${preview.version}`,
    `说明：${preview.description}`,
    '能力：',
    capabilities,
    `网络：${preview.egressHosts.length ? preview.egressHosts.join('、') : '仅本地'}`,
    `平台：${preview.platforms.join('、')}`,
    `离线：${preview.offline === 'read_cache' ? '仅读取缓存' : '不支持离线'}`,
    `声明许可：${preview.license}`,
    '',
    '这是第三方代码，将在独立进程中运行。只安装你信任的来源；确认后仍会默认停用，重启在场后生效。',
  ].join('\n');
}
async function confirmPluginPackage(preview: PluginPackagePreview, mode: 'install' | 'upgrade') {
  const result = await dialog.showMessageBox(window!, {
    type: 'warning',
    title: mode === 'install' ? '确认导入第三方插件' : '确认升级第三方插件',
    message: `已识别为在场插件“${preview.displayName}”`,
    detail: pluginPreviewDetail(preview),
    buttons: ['取消', mode === 'install' ? '导入插件' : '确认升级'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}
function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
    throw new Error('无效的请求来源。');
  const url = new URL(event.senderFrame.url);
  let trustedDevOrigin = false;
  if (process.env.ZAICHANG_DEV === '1') {
    try {
      trustedDevOrigin = url.origin === new URL(devServerUrl).origin;
    } catch {
      trustedDevOrigin = false;
    }
  }
  if (
    !(url.protocol === 'app:' && url.hostname === 'zaichang') &&
    !trustedDevOrigin
  )
    throw new Error('无效的请求来源。');
}
function handle(name: string, fn: (data: any) => unknown | Promise<unknown>) {
  ipcMain.handle(name, async (event, data) => {
    trusted(event);
    try {
      return await fn(data);
    } catch (error) {
      if (error instanceof z.ZodError) throw new Error('请检查填写内容、长度和时间格式后重试。');
      throw error;
    }
  });
}
function noRun() {
  if (harness.running) throw new Error('请先停止当前处理，再修改连接或资料。');
}
const id = z.string().min(1).max(100);
const textAttachmentSchema = z.union([
  z
    .object({
      kind: z.literal('text'),
      name: z.string().max(LIMITS.fileName),
      text: z.string().max(LIMITS.attachmentText),
    })
    .strict(),
  z
    .object({
      name: z.string().max(LIMITS.fileName),
      text: z.string().max(LIMITS.attachmentText),
    })
    .strict()
    .transform((value) => ({ kind: 'text' as const, ...value })),
]);
const imageAttachmentSchema = z
  .object({
    kind: z.literal('image'),
    name: z.string().max(LIMITS.fileName),
    mimeType: z.literal('image/jpeg'),
    dataUrl: z
      .string()
      .max(LIMITS.imageDataUrl)
      .refine((value) => value.startsWith('data:image/jpeg;base64,')),
    width: z.number().int().min(1).max(1600),
    height: z.number().int().min(1).max(1600),
  })
  .strict();
const draftSchema = z
  .object({
    text: z.string().max(LIMITS.draftText),
    attachment: z.union([textAttachmentSchema, imageAttachmentSchema]).nullable(),
  })
  .strict();
function draft(value: unknown): Draft {
  const parsed = draftSchema.safeParse(value);
  return parsed.success ? parsed.data : { text: '', attachment: null };
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  keyPath = path.join(dataDir, 'deepseek-key.bin');
  store = new Store(path.join(dataDir, 'zaichang.sqlite'), {
    pluginRoot: path.join(dataDir, 'plugins'),
    pluginRunnerPath: path.join(__dirname, 'plugin-runner.cjs'),
  });
  // The explicit project entry point means this app session should use the
  // project model rather than silently falling back to the demo responder.
  // No request is sent until the user starts a conversation.
  if (projectDeepSeekKey || usingLunaTestTransport()) store.saveSettings({ mode: 'deepseek' });
  zju = new ZjuAdapter(store);
  map = new CampusMapAdapter(path.join(app.getAppPath(), 'assets', 'map-v2'));
  harness = new Harness(
    store,
    getKey,
    (event) => {
      if (window && !window.isDestroyed()) window.webContents.send('zaichang:event', event);
    },
    undefined,
    zju,
    map,
    () => {
      const key = getKey();
      return invalidStoredKey ? 'invalid' : key ? 'available' : 'missing';
    },
  );
  store.runtime.connect({ location: weatherLocation });
  const controls = new NativeControls(store, harness);
  handle('runtime:overview', () => controls.overview());
  handle('runtime:adopt-world', (value) => controls.adoptWorld(value));
  handle('runtime:evidence', (value) => controls.evidence(value));
  handle('runtime:goal', (value) => controls.goal(value));
  handle('runtime:feedback', (value) => controls.feedback(value));
  handle('runtime:retry', (value) => controls.retry(value));
  handle('runtime:reconcile', (value) => controls.reconcile(value));
  handle('runtime:action', (value) => {
    const actionId = id.parse(value),
      scope = store.runtime.policy.hostScope();
    return {
      action: store.runtime.actions.get(scope, actionId) || null,
      receipts: store.runtime.actions.receipts(scope, actionId),
    };
  });
  handle('runtime:permission', (value) => controls.permission(value));
  const root = path.join(app.getAppPath(), 'dist');
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'zaichang') return new Response('Forbidden', { status: 403 });
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Invalid path', { status: 400 });
    }
    const file = path.resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
    if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile())
      return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_w, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  handle('state', state);
  handle('messages', (value) => store.messages(id.parse(value)));
  const drafts = new DraftStore(store);
  handle('draft', (value) => draft(drafts.get(id.parse(value))));
  handle('draft:info', value => drafts.info(id.parse(value)));
  handle('draft:unsaved', () => drafts.unsaved());
  handle('draft:persist', value => {
    const input = z.object({ id, digest: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).strict().parse(value);
    drafts.persist(input.id, input.digest);
  });
  handle('draft:save', (value) => {
    const input = z
      .object({
        id,
        retention: z.literal('session_only').optional(),
        privacyEpoch: z.number().int().positive().optional(),
        draft: draftSchema,
      })
      .parse(value);
    drafts.save(input.id, input.draft, input.retention === 'session_only', input.privacyEpoch);
  });
  handle('send', (value) => {
    const input = z
      .object({
        sessionId: id.optional(),
        content: z.string().trim().min(1).max(LIMITS.message),
        image: imageAttachmentSchema.optional(),
        controls: z
          .object({
            transmission: z.enum(['cloud_allowed', 'local_only']).optional(),
            memoryMode: z.enum(['relevant', 'current_sources_only', 'session_only', 'none']).optional(),
            retention: z.enum(['purpose_scoped', 'history_no_inference', 'session_only']).optional(),
            audience: z.enum(['self', 'group', 'public']).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(value);
    if (store.settings().mode === 'deepseek' && !getKey() && !usingLunaTestTransport())
      throw new Error(missingKeyError());
    return harness.start(input.sessionId, input.content, input.controls, input.image);
  });
  handle('stop', () => harness.stop());
  handle('settings:save', (value) => {
    const { apiKey, ...settings } = settingsSchema.parse(value);
    const disablingOnly =
      !apiKey &&
      Object.entries(settings).every(
        ([key, val]) =>
          ['memoryEnabled', 'weatherEnabled', 'weatherUseLocation', 'remindersEnabled'].includes(key) && val === false,
      );
    if (!disablingOnly) noRun();
    if (settings.mode === 'deepseek' && !(apiKey || getKey()) && !usingLunaTestTransport())
      throw new Error(
        invalidStoredKey
          ? '已保存的 DeepSeek API Key 无法读取，请重新输入并保存。'
          : '先填写 DeepSeek API Key，再开始连接。',
      );
    if (apiKey) saveKey(apiKey);
    store.saveSettings(settings as Partial<Settings>);
    return state();
  });
  handle('connection:test', async (value) => {
    noRun();
    const input = z.object({ apiKey: z.string().trim().max(512).optional() }).strict().parse(value);
    connectionController?.abort();
    const controller = new AbortController();
    connectionController = controller;
    try {
      const apiKey = input.apiKey || getKey();
      if (!apiKey) throw new Error(missingKeyError());
      await createModelClient(apiKey, DEEPSEEK_MODEL).complete(
        [{ role: 'user', content: '请只回复：连接成功。' }],
        [],
        AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      );
      return usingLunaTestTransport() ? 'GPT‑5.6‑Luna 临时代测已响应。' : 'DeepSeek 已响应。';
    } catch (e) {
      throw new Error(friendlyError(e));
    } finally {
      if (connectionController === controller) connectionController = undefined;
    }
  });
  handle('connection:cancel', () => {
    connectionController?.abort();
  });
  handle('key:delete', () => {
    noRun();
    deleteKey();
    store.saveSettings({ mode: 'demo' });
    return state();
  });
  handle('interfaces', () => store.runtime.interfaces.list());
  handle('interface:set-enabled', (value) => {
    noRun();
    const input = z.object({ id, enabled: z.boolean() }).strict().parse(value);
    store.runtime.interfaces.setEnabled(input.id, input.enabled);
    if (input.id === 'weather') store.saveSettings({ weatherEnabled: input.enabled });
    return state();
  });
  handle('plugin:install', async () => {
    noRun();
    const result = await dialog.showOpenDialog(window!, {
      title: '导入在场插件包（需包含 plugin.json）',
      filters: [{ name: '在场插件包', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return state();
    const preview = store.runtime.plugins.previewArchive(result.filePaths[0]);
    if (!(await confirmPluginPackage(preview, 'install'))) return state();
    store.runtime.plugins.installFromArchive(result.filePaths[0]);
    return state();
  });
  handle('plugin:upgrade', async (value) => {
    noRun();
    const input = z.object({ id }).strict().parse(value);
    const result = await dialog.showOpenDialog(window!, {
      title: '导入插件升级包（需包含 plugin.json）',
      filters: [{ name: '在场插件包', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return state();
    const preview = store.runtime.plugins.previewArchive(result.filePaths[0]);
    if (preview.id !== input.id) throw new Error('所选插件包不是当前插件的升级包。');
    if (!(await confirmPluginPackage(preview, 'upgrade'))) return state();
    store.runtime.plugins.installFromArchive(result.filePaths[0], input.id);
    return state();
  });
  handle('plugin:uninstall', (value) => {
    noRun();
    const input = z.object({ id }).strict().parse(value);
    store.runtime.plugins.uninstall(input.id);
    return state();
  });
  handle('memory', (value) => {
    const input = z
      .object({
        action: z.enum(['save', 'delete', 'deactivate']),
        id: id.optional(),
        text: z.string().trim().min(1).max(4000).optional(),
        expectedRevision: z.number().int().positive().optional(),
        operation: z.enum(['CORRECT', 'SUPERSEDE', 'ADD_EXCEPTION', 'REFINE']).optional(),
        validFrom: z.string().datetime({ offset: true }).optional(),
        validTo: z.string().datetime({ offset: true }).optional(),
        conditions: conditionSchema.optional(),
      })
      .parse(value);
    if (input.action === 'delete' && input.id) store.deleteMemory(input.id);
    else if (input.action === 'deactivate' && input.id) store.runtime.memory.deactivate(input.id);
    else if (input.action === 'save' && input.text)
      store.runtime.memory.saveControl(input.text, input.id, input);
    else throw new Error('请填写记忆内容。');
    return state();
  });
  handle('conversation:delete', (value) => {
    noRun();
    const sessionId = id.parse(value);
    drafts.clear(sessionId);
    store.deleteSession(sessionId);
    harness.invalidateCampusCache(sessionId);
    return state();
  });
  handle('data:clear', async () => {
    noRun();
    await zju.forgetCredentials(AbortSignal.timeout(20_000)).catch(() => {});
    store.clear();
    drafts.clear();
    deleteKey();
    harness.invalidateCampusCache();
    return state();
  });
  handle('campus:import', async () => {
    noRun();
    const result = await dialog.showOpenDialog(window!, {
      title: '导入校园资料',
      filters: [{ name: '校园资料 JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if (statSync(file).size > 8_000_000) throw new Error('资料文件过大，请使用 8 MB 以内的 JSON 文件。');
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      throw new Error('这不是有效的 JSON 文件。');
    }
    const data = campusSchema.safeParse(parsed);
    if (!data.success)
      throw new Error('资料格式不匹配：请包含来源、更新时间和含时区的逐次日程。项目 examples 中有模板。');
    // Last occurrence wins when an exported event is rescheduled or cancelled.
    data.data.schedule = [...new Map(data.data.schedule.map((e) => [e.id, e])).values()];
    data.data.exams = [...new Map(data.data.exams.map((e) => [e.id, e])).values()];
    store.runtime.domains.importSnapshot(data.data, Object.keys(parsed as object));
    harness.invalidateCampusCache();
    return state();
  });
  handle('campus:disconnect', () => {
    noRun();
    store.putMeta('campus', null);
    harness.invalidateCampusCache();
    return state();
  });
  handle('campus:template', async () => {
    const result = await dialog.showSaveDialog(window!, {
      title: '保存校园资料模板',
      defaultPath: '校园资料-格式示例.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return false;
    writeFileSync(result.filePath, JSON.stringify(campusExample, null, 2), 'utf8');
    return true;
  });
  handle('campus:connector:configure', async () => {
    noRun();
    const result = await dialog.showOpenDialog(window!, {
      title: '选择浙大个人信息连接器目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return state();
    zju.configure(result.filePaths[0]);
    harness.invalidateCampusCache();
    return state();
  });
  handle('campus:account:connect', async () => {
    noRun();
    try {
      zju.connectInstalled();
    } catch {
      const result = await dialog.showOpenDialog(window!, {
        title: '选择浙大个人信息技能目录',
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return state();
      zju.configure(result.filePaths[0]);
    }
    if (!zju.describe().credentialsConfigured) await zju.configureCredentials();
    const verified = await zju.verifyAccount(AbortSignal.timeout(75_000));
    if (verified.status !== 'ok')
      throw new Error(
        verified.error?.message || verified.reason || '没有完成浙大统一身份认证，请检查网络或登录信息。',
      );
    harness.invalidateCampusCache();
    return state();
  });
  handle('campus:connector:disconnect', () => {
    noRun();
    zju.disconnect();
    harness.invalidateCampusCache();
    return state();
  });
  handle('campus:connector:credentials', async () => {
    noRun();
    await zju.configureCredentials();
    const verified = await zju.verifyAccount(AbortSignal.timeout(75_000));
    if (verified.status !== 'ok')
      throw new Error(
        verified.error?.message || verified.reason || '登录信息已加密保存，但浙大统一身份认证没有完成。',
      );
    harness.invalidateCampusCache();
    return state();
  });
  handle('campus:connector:forget-credentials', async () => {
    noRun();
    const result = await zju.forgetCredentials(AbortSignal.timeout(20_000));
    if (result.status !== 'ok')
      throw new Error(result.error?.message || result.reason || '没有移除本机登录信息。');
    harness.invalidateCampusCache();
    return state();
  });
  handle('map:overview', () => map.overview());
  handle('map:search', (value) => {
    const input = z
      .object({ query: z.string().trim().min(1).max(100), limit: z.number().int().min(1).max(50).optional() })
      .parse(value);
    return map.search(input.query, input.limit || 20);
  });
  handle('map:location-status', () => map.locationStatus());
  handle('map:locate', () => mapLocation.read(map.overview()));
  handle('map:location-stop', () => mapLocation.cancel());
  handle('map:route', (value) => {
    const place = z.object({ kind: z.enum(['place', 'node']), id: z.string().min(1).max(100) });
    const input = z
      .object({
        from: z.union([place, z.object({ kind: z.literal('current') })]).optional(),
        to: place.optional(),
        avoidStairs: z.boolean().optional(),
        version: z.string().max(100).optional(),
      })
      .parse(value);
    return map.route(input);
  });
  handle('action', async (value) => {
    const input = z.object({ action: z.enum(['save', 'delete', 'done']), item: actionSchema }).parse(value);
    if (input.action === 'delete') {
      if (store.runtime.calendar.read(input.item.id)) await store.runtime.changeLocalFromUI(input.item, 'delete');
      else await store.runtime.actions.cancel(store.runtime.policy.hostScope(), input.item.effectActionId || input.item.id);
    } else
      await store.runtime.acceptLocal({ ...input.item, done: input.action === 'done' || input.item.done });
    return state();
  });
  handle('text:attach', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: '添加文字资料',
      filters: [{ name: '文字或 Markdown', extensions: ['txt', 'md'] }],
      properties: ['openFile'],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if (statSync(file).size > 100_000) throw new Error('请选取 100 KB 以内的文字资料。');
    const text = readFileSync(file, 'utf8');
    if (text.length > LIMITS.attachmentText)
      throw new Error('这份文字太长，请先摘出 20,000 字以内的相关内容。');
    return { kind: 'text', name: path.basename(file), text };
  });
  handle('image:attach', async (): Promise<ImageAttachment | null> => {
    const result = await dialog.showOpenDialog(window!, {
      title: '添加图片',
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
      properties: ['openFile'],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if (statSync(file).size > 8_000_000) throw new Error('请选取 8 MB 以内的图片。');
    const source = nativeImage.createFromBuffer(readFileSync(file));
    if (source.isEmpty()) throw new Error('这张图片无法读取，请换一张。');
    const original = source.getSize();
    if (!original.width || !original.height || original.width > 12_000 || original.height > 12_000)
      throw new Error('这张图片尺寸过大，请换一张。');
    const scale = Math.min(1, 1600 / original.width, 1600 / original.height);
    const prepared =
      scale < 1
        ? source.resize({
            width: Math.max(1, Math.round(original.width * scale)),
            height: Math.max(1, Math.round(original.height * scale)),
            quality: 'best',
          })
        : source;
    let bytes = prepared.toJPEG(90),
      size = prepared.getSize();
    if (bytes.length * 1.34 > LIMITS.imageDataUrl) {
      const smallerScale = Math.min(1, 1280 / size.width, 1280 / size.height);
      const smaller = prepared.resize({
        width: Math.max(1, Math.round(size.width * smallerScale)),
        height: Math.max(1, Math.round(size.height * smallerScale)),
        quality: 'good',
      });
      bytes = smaller.toJPEG(82);
      size = smaller.getSize();
    }
    const dataUrl = 'data:image/jpeg;base64,' + bytes.toString('base64');
    if (dataUrl.length > LIMITS.imageDataUrl) throw new Error('这张图片处理后仍然过大，请换一张。');
    return {
      kind: 'image',
      name: path.basename(file),
      mimeType: 'image/jpeg',
      dataUrl,
      width: size.width,
      height: size.height,
    };
  });
  handle('data:export', async () => {
    const result = await dialog.showSaveDialog(window!, {
      title: '导出我的资料',
      defaultPath: '在场-我的资料.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return false;
    writeFileSync(result.filePath, JSON.stringify(store.export(), null, 2), 'utf8');
    return true;
  });
  handle('link:open', async (value) => {
    const url = new URL(z.string().max(2500).parse(value));
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname)
      throw new Error('仅支持打开安全的 HTTPS 来源链接。');
    await shell.openExternal(url.toString());
  });
  handle('text:copy', (value) => {
    clipboard.writeText(z.string().max(100000).parse(value));
  });
  ipcMain.on('window', (event, value) => {
    trusted(event);
    if (value === 'close') window?.close();
    if (value === 'minimize') window?.minimize();
    if (value === 'maximize') window?.isMaximized() ? window.unmaximize() : window?.maximize();
  });
  window = new BrowserWindow({
    title: '在场',
    width: 1220,
    height: 850,
    minWidth: 680,
    minHeight: 570,
    backgroundColor: '#171918',
    frame: false,
    show: false,
    icon: path.join(app.getAppPath(), 'build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('close', (event) => {
    if (!closing && harness.running) {
      event.preventDefault();
      closing = true;
      void harness.stop().finally(() => window?.close());
    }
  });
  window.on('closed', () => {
    window = undefined;
  });
  await window.loadURL(
    process.env.ZAICHANG_DEV === '1' ? devServerUrl : 'app://zaichang/index.html',
  );
  store.runtime.reminders.port = {
    capabilities: {
      submitted: Notification.isSupported(),
      delivered: false,
      seen: false,
      stableId: false,
      closedApp: false,
    },
    submit: async (input, signal) => {
      signal.throwIfAborted();
      const notice = new Notification({ title: input.title, body: input.body, silent: true });
      notice.on('click', () => {
        window?.restore();
        window?.show();
        window?.focus();
      });
      notice.show();
      return { status: 'submitted_to_os' };
    },
  };
  store.runtime.reminders.configure({ enabled: store.settings().remindersEnabled });
  const reminderTimer = setInterval(() => {
    void store.runtime.reminders.runDue();
  }, 30000);
  const recoveryTimer = setInterval(() => {
    if (process.env.ZAICHANG_TEST !== '1') void harness.recoverPending();
  }, 30000);
  void store.runtime.reminders.runDue();
  app.on('will-quit', () => {
    clearInterval(reminderTimer);
    clearInterval(recoveryTimer);
    store.close();
  });
});
app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  mapLocation.cancel();
  weatherLocation.cancel();
});
