import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

type Pending = { resolve(value: unknown): void; reject(reason: unknown): void };
const entryManifest = process.argv[2];
const entryName = process.argv[3];
const pendingRequests = new Map<number, Pending>();
let nextRequestId = 0;
let plugin: any;

function send(value: unknown) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

async function load() {
  if (plugin) return plugin;
  if (!entryManifest || !entryName) throw new Error('插件启动参数不完整。');
  const moduleValue: any = await import(pathToFileURL(path.resolve(process.cwd(), entryName)).href);
  const exported = moduleValue.default ?? moduleValue.plugin ?? moduleValue;
  plugin =
    typeof exported === 'function'
      ? await exported(JSON.parse(readFileSync(entryManifest, 'utf8')))
      : exported;
  if (!plugin || typeof plugin.invoke !== 'function') throw new Error('插件入口必须导出 invoke 方法。');
  return plugin;
}

function requestHost(callId: string, url: string, init: RequestInit) {
  const id = ++nextRequestId;
  send({ id, method: 'request', params: { callId, url, init } });
  return new Promise<Response>((resolve, reject) => {
    pendingRequests.set(id, {
      resolve: (value) => {
        const response = value as { status: number; headers: Record<string, string>; body: string };
        resolve(new Response(response.body, { status: response.status, headers: response.headers }));
      },
      reject,
    });
  });
}

async function handle(message: any) {
  if (message.id !== undefined && pendingRequests.has(Number(message.id))) {
    const pending = pendingRequests.get(Number(message.id));
    if (!pending) return;
    pendingRequests.delete(Number(message.id));
    if (message.error) pending.reject(new Error(String(message.error.message || '宿主请求失败。')));
    else pending.resolve(message.result);
    return;
  }
  if (message.method === 'initialize') {
    await load();
    send({ id: message.id, result: { ready: true } });
    return;
  }
  const value = await load();
  const method =
    message.method === 'inspect' ? value.inspect : message.method === 'cancel' ? value.cancel : value.invoke;
  if (typeof method !== 'function') throw new Error(`插件未实现 ${message.method} 能力。`);
  const params = message.params || {};
  const context = {
    capability: params.name,
    deadline: params.deadline,
    idempotencyKey: params.idempotencyKey,
    signal: new AbortController().signal,
    request: (url: string, init?: RequestInit) => requestHost(String(params.callId), url, init || {}),
  };
  const result = await method.call(value, {
    name: params.name,
    args: params.args,
    key: params.key,
    context,
  });
  send({ id: message.id, result });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  void handle(message).catch((error) => {
    send({ id: message.id, error: { message: error instanceof Error ? error.message : '插件执行失败。' } });
  });
});
