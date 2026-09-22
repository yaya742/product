import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProviderError, readSSE, type Completion, type CompletionOptions, type ModelWireMessage, type ProviderMetadata, type ToolSpec, type WireMessage } from './provider';

export const LUNA_MODEL = 'gpt-5.6-luna';
export const LUNA_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
export const LUNA_SUBSTITUTE = { providerId: 'openai-app-server', model: LUNA_MODEL, temporaryTestSubstitute: true, replaces: 'deepseek-flash', reasoningEffort: 'xhigh' } as const;
type Item = Record<string, any>;

/** Translate protocol roles and native image parts; never summarize source text. */
export function lunaInput(messages: ModelWireMessage[], opaque: (id: string) => Item[] | undefined = decodeProtocol): Item[] {
  return messages.flatMap(message => {
    if (message.role === 'assistant' && message.reasoning_content?.startsWith('zaichang-luna:')) {
      const items = opaque(message.reasoning_content);
      if (items) return structuredClone(items);
    }
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content || '' }];
    const result: Item[] = [];
    if (message.content) result.push({ type: 'message', role: message.role === 'system' ? 'developer' : message.role, content: typeof message.content === 'string'
      ? [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }]
      : message.content.map(part => part.type === 'text' ? { type: 'input_text', text: part.text } : { type: 'input_image', image_url: part.image_url.url, detail: 'original' }) });
    for (const call of message.tool_calls || []) result.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    return result;
  });
}

export function lunaRequest(messages: ModelWireMessage[], tools: ToolSpec[], options: CompletionOptions = {}, opaque?: (id: string) => Item[] | undefined) {
  return {
    model: LUNA_MODEL, instructions: '', input: lunaInput(messages, opaque),
    tools: tools.map(tool => ({ type: 'function', ...tool.function, strict: Boolean(options.strict) })),
    tool_choice: options.toolChoice ? { type: 'function', name: options.toolChoice.function.name } : 'auto',
    parallel_tool_calls: true, reasoning: { effort: options.thinking === 'disabled' ? 'none' : LUNA_SUBSTITUTE.reasoningEffort },
    store: false, stream: true, include: ['reasoning.encrypted_content'],
  };
}

/** Account-backed test transport. Hermes remains the only application loop.
 * App Server authenticates a single ephemeral request to a secret loopback URL.
 * The bridge replaces Codex's automatic prompt/tools with the exact Harness
 * request. Actual Responses items go directly to Hermes; a transport-only ACK
 * ends the App Server turn, so no model-selected native tool can execute there.
 * Tokens are forwarded in memory only to the fixed official endpoint.
 */
export class AppServerLunaClient {
  readonly model = LUNA_MODEL;
  readonly capabilities = { providerId: LUNA_SUBSTITUTE.providerId, protocol: 'app-server-responses', protocolVersion: 'single-completion-v1', version: 'single-completion-v1', modalities: ['text', 'image'], toolDialect: 'function_calls', endpoint: LUNA_ENDPOINT, strictEndpoint: LUNA_ENDPOINT, thinking: true, reasoningContent: true, toolCalls: true, toolContinuation: true, strictTools: true, structuredOutput: false, opaqueState: 'bounded_tool_chain' };
  private protocol = new WeakMap<Completion, string>();
  private controllers = new Set<AbortController>();
  constructor(private dependencies: { fetcher?: typeof fetch; executable?: string; spawn?: typeof spawn } = {}) {}
  providerMetadata(options?: CompletionOptions): ProviderMetadata {
    return { ...LUNA_SUBSTITUTE, endpoint: LUNA_ENDPOINT, protocol: this.capabilities.protocol, protocolVersion: this.capabilities.protocolVersion, capabilities: { ...this.capabilities }, limits: { maxOutputTokens: options?.maxOutputTokens || 4096, contextTokens: 1_000_000, outputEnforcement: 'host_post_completion' } };
  }
  assistantMessage(result: Completion): WireMessage {
    return { role: 'assistant', content: result.content || null, ...(result.tool_calls.length ? { tool_calls: result.tool_calls } : {}), ...(this.protocol.has(result) ? { reasoning_content: this.protocol.get(result) } : {}) };
  }
  invalidateBoundary() {
    this.protocol = new WeakMap();
    for (const controller of this.controllers) controller.abort(new DOMException('Model boundary invalidated', 'AbortError'));
  }
  async complete(messages: ModelWireMessage[], tools: ToolSpec[], callerSignal: AbortSignal, onText?: (text: string) => void, options?: CompletionOptions): Promise<Completion> {
    callerSignal.throwIfAborted();
    if (options?.maxOutputTokens !== undefined && (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 256 || options.maxOutputTokens > 32768)) throw new ProviderError('本轮输出预算不合法。');
    const body = lunaRequest(messages, tools, options);
    const maxOutputTokens = options?.maxOutputTokens || 4096;
    const controller = new AbortController(); this.controllers.add(controller);
    const signal = AbortSignal.any([callerSignal, controller.signal, AbortSignal.timeout(120_000)]);
    const cwd = await mkdtemp(path.join(tmpdir(), 'zaichang-luna-'));
    const route = '/' + randomUUID();
    let child: ChildProcessWithoutNullStreams | undefined;
    let resolve!: (value: Completion) => void, reject!: (reason: unknown) => void;
    const completion = new Promise<Completion>((yes, no) => { resolve = yes; reject = no; });
    // Avoid unhandled rejection while initialize/thread/start are outstanding.
    completion.catch(() => {});
    let admitted = false;
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== route + '/responses' || admitted || signal.aborted) { response.writeHead(404).end(); return; }
      admitted = true;
      try {
      // App Server's generated prompt is neither persisted nor sent upstream.
      let bytes = 0; for await (const chunk of request) { bytes += chunk.length; if (bytes > 8_000_000) { response.writeHead(413).end(); reject(new ProviderError('App Server 请求超过传输上限。')); return; } }
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) { response.writeHead(401).end(); reject(new ProviderError('App Server 尚未登录，请先在 Codex 登录。', false, 'authentication', 401)); return; }
        const headers: Record<string, string> = { authorization, 'content-type': 'application/json', accept: 'text/event-stream', 'openai-beta': 'responses=experimental' };
        for (const name of ['chatgpt-account-id', 'originator', 'user-agent']) { const value = request.headers[name]; if (typeof value === 'string') headers[name] = value; }
        const upstream = await (this.dependencies.fetcher || fetch)(LUNA_ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
        if (!upstream.ok) {
          // Error bodies can echo input; only transport status is exposed.
          await upstream.body?.cancel();
          throw new ProviderError(`Luna 代测请求未完成（HTTP ${upstream.status}）。`, false, upstream.status === 401 ? 'authentication' : [402, 429].includes(upstream.status) ? 'quota' : 'protocol', upstream.status);
        }
        let ended = false, content = '', usage: Completion['usage'];
        const items: Item[] = [];
        await readSSE(upstream, data => {
          if (!data || data === '[DONE]') return;
          const event = JSON.parse(data);
          if (event.type === 'response.output_text.delta') { content += event.delta; if (content.length > 64000) throw new ProviderError('回复达到本次长度上限。'); onText?.(event.delta); }
          if (event.type === 'response.output_item.done') items.push(event.item);
          if (event.response?.usage) {
            const value = event.response.usage;
            usage = { prompt_tokens: value.input_tokens, completion_tokens: value.output_tokens, total_tokens: value.total_tokens, prompt_cache_hit_tokens: value.input_tokens_details?.cached_tokens || 0, providerId: LUNA_SUBSTITUTE.providerId, model: LUNA_MODEL };
          }
          if (event.type === 'response.incomplete') throw new ProviderError('Luna 代测回复达到长度上限。', false, 'output_length', undefined, usage);
          if (event.type === 'error' || event.type === 'response.failed') throw new ProviderError('Luna 代测服务中断了本次请求。', false, 'protocol', undefined, usage);
          if (event.type === 'response.completed') {
            if (event.response.model && event.response.model !== LUNA_MODEL) throw new ProviderError('App Server 返回了非指定模型，代测已停止。', false, 'model_mismatch');
            ended = true;
            if (!items.length && event.response.output) items.push(...event.response.output);
          }
        }, signal);
        if (!ended) throw new ProviderError('Luna 代测连接在完成前断开。', false, 'protocol', undefined, usage);
        const tool_calls = items.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, type: 'function' as const, function: { name: item.name, arguments: item.arguments } }));
        if (tool_calls.length > 8 || tool_calls.some(call => !call.id || !tools.some(tool => tool.function.name === call.function.name) || call.function.arguments.length > 20000)) throw new ProviderError('Luna 返回了不在本轮工具契约内的请求。', false, 'protocol', undefined, usage);
        if (items.some(item => !['message', 'reasoning', 'function_call'].includes(item.type))) throw new ProviderError('Luna 返回了额外原生工具，代测已停止。', false, 'protocol', undefined, usage);
        if (!content) content = items.filter(item => item.type === 'message').flatMap(item => item.content || []).map(part => part.text || '').join('');
        if (!content && !tool_calls.length) throw new ProviderError('Luna 没有返回可用内容。', false, 'protocol', undefined, usage);
        if (usage && usage.completion_tokens > maxOutputTokens) throw new ProviderError('Luna 超出宿主输出上限，结果未采用。', false, 'output_length', undefined, usage);
        const result: Completion = { content, tool_calls, usage };
        if (JSON.stringify(items).length > Math.max(64000, maxOutputTokens * 16)) throw new ProviderError('Luna 协议状态超过本轮上限。', false, 'protocol_budget', undefined, usage);
        // Same lifecycle as DeepSeek reasoning_content: the host's bounded,
        // scoped in-memory protocol chain carries this across client instances.
        this.protocol.set(result, 'zaichang-luna:' + JSON.stringify(items));
        // A transport ACK only. The actual model result is never interpreted by
        // Codex's execution loop and is returned exclusively through resolve().
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'bridge_ack', status: 'completed', output: [] } }) + '\n\n');
        resolve(result);
      } catch (error) { response.writeHead(502).end(); reject(error); }
    });
    const pending = new Map<number, { resolve(value: any): void; reject(reason: unknown): void }>();
    let nextId = 0;
    const abort = () => { reject(signal.reason); for (const call of pending.values()) call.reject(signal.reason); child?.kill(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
      signal.throwIfAborted();
      const port = (server.address() as { port: number }).port;
      const features = Object.fromEntries(['shell_tool', 'unified_exec', 'shell_snapshot', 'multi_agent', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'computer_use', 'image_generation', 'memories', 'hooks', 'goals', 'skill_search', 'sleep_tool', 'workspace_dependencies', 'context_management', 'code_mode', 'view_image'].map(name => [name, false]));
      const config = { features, web_search: 'disabled', tools: { view_image: false }, project_doc_max_bytes: 0, history: { persistence: 'none' }, model_context_window: 1_000_000, model_auto_compact_token_limit: 999_999_999,
        model_provider: 'zaichang_luna_test', model_providers: { zaichang_luna_test: { name: 'Luna temporary test transport', base_url: `http://127.0.0.1:${port}${route}`, wire_api: 'responses', requires_openai_auth: true, request_max_retries: 0, stream_max_retries: 0 } } };
      child = (this.dependencies.spawn || spawn)(this.dependencies.executable || lunaExecutable(), ['app-server', ...Object.entries(features).flatMap(([name, value]) => ['-c', `features.${name}=${value}`])], { cwd, env: lunaEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
      child.stderr.resume(); // never persist CLI logs, which may contain prompts
      child.on('error', error => { reject(error); for (const call of pending.values()) call.reject(error); });
      child.on('exit', () => { const error = new ProviderError('App Server 代测进程已结束。'); reject(error); for (const call of pending.values()) call.reject(error); });
      createInterface({ input: child.stdout }).on('line', line => {
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined && !message.method) { const call = pending.get(message.id); if (!call) return; pending.delete(message.id); message.error ? call.reject(new ProviderError('App Server 未接受代测协议。', false, 'protocol')) : call.resolve(message.result); }
          // Native tool calls are never part of this transport contract.
          else if (message.id !== undefined) { child?.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Model transport exposes no native tool executor.' } }) + '\n'); }
          else if (message.method === 'turn/completed' && !admitted) reject(new ProviderError('App Server 未发起模型请求。', false, 'authentication'));
        } catch { reject(new ProviderError('App Server 返回了无效传输帧。', false, 'protocol')); }
      });
      const rpc = (method: string, params: unknown) => new Promise<any>((yes, no) => { const id = ++nextId; pending.set(id, { resolve: yes, reject: no }); child!.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
      await rpc('initialize', { clientInfo: { name: 'zaichang_luna_test_transport', version: '1' }, capabilities: { experimentalApi: true } });
      child.stdin.write('{"method":"initialized"}\n');
      // Discover only configured names through the supported read API, then
      // disable every inherited MCP server before creating the ephemeral turn.
      // The configuration object is never logged, persisted or forwarded.
      const inherited = await rpc('config/read', { cwd, includeLayers: false });
      Object.assign(config, { mcp_servers: Object.fromEntries(Object.keys(inherited.config?.mcp_servers || {}).map(name => [name, { enabled: false }])) });
      const started = await rpc('thread/start', { model: LUNA_MODEL, modelProvider: 'zaichang_luna_test', allowProviderModelFallback: false, cwd, ephemeral: true, baseInstructions: 'Complete the transport request.', developerInstructions: '', environments: [], selectedCapabilityRoots: [], approvalPolicy: 'never', sandbox: 'read-only', config });
      if (started.model !== LUNA_MODEL || started.thread.ephemeral !== true) throw new ProviderError('App Server 模型或临时会话契约不符。', false, 'model_mismatch');
      await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Transport request.', text_elements: [] }], effort: LUNA_SUBSTITUTE.reasoningEffort });
      return await completion;
    } finally {
      signal.removeEventListener('abort', abort); controller.abort(); this.controllers.delete(controller);
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise<void>(yes => child!.once('exit', () => yes()));
        child.kill(); await stopped;
      }
      server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes()));
      // Only remove the exact empty scratch directory created above; no
      // recursive cleanup of user data or shared Codex authentication files.
      await rmdir(cwd).catch(() => {});
    }
  }
}

function decodeProtocol(value: string): Item[] {
  if (value.length > 530000) throw new ProviderError('Luna 协议状态超过本轮上限。', false, 'protocol_budget');
  const items = JSON.parse(value.slice('zaichang-luna:'.length));
  if (!Array.isArray(items) || items.some(item => !['message', 'reasoning', 'function_call'].includes(item.type))) throw new ProviderError('Luna 协议续接内容无效。', false, 'protocol');
  return items;
}

export function lunaEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { RUST_LOG: 'off' };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'CODEX_HOME']) if (process.env[name]) env[name] = process.env[name];
  return env;
}
function lunaExecutable(): string {
  if (process.env.ZAICHANG_CODEX_EXECUTABLE && existsSync(process.env.ZAICHANG_CODEX_EXECUTABLE)) return process.env.ZAICHANG_CODEX_EXECUTABLE;
  const root = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (existsSync(root)) for (const entry of readdirSync(root).reverse()) { const file = path.join(root, entry, 'codex.exe'); if (existsSync(file)) return file; }
  throw new ProviderError('未找到 App Server CLI，Luna 代测无法启动。', false, 'runtime_unavailable');
}
