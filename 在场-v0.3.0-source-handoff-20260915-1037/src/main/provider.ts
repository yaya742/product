import { DEEPSEEK_MODEL } from '../shared/types';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
export interface WireMessage<Content = string | null> {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: Content;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}
export type ModelWireMessage = WireMessage<string | null | WireContentPart[]>;
/** Hermes may join adjacent user messages as adjacent text parts. Preserve
 * all text and image order while keeping a single text part before the image. */
export function coalesceUserTextParts(messages: ModelWireMessage[]): ModelWireMessage[] {
  return messages.map(message => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message;
    const content: WireContentPart[] = [];
    for (const part of message.content) {
      const last = content.at(-1);
      if (part.type === 'text' && last?.type === 'text') last.text += '\n\n' + part.text;
      else content.push(part.type === 'text' ? { ...part } : part);
    }
    return { ...message, content };
  });
}
export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface Completion {
  content: string;
  tool_calls: ToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; providerId?: string; model?: string };
}
export interface CompletionOptions {
  phase?: 'control' | 'main' | 'child' | 'memory_extract' | 'memory_review' | 'completion_review' | 'verification' | 'compression' | 'evaluation_judge' | 'release_write' | 'release_review';
  actorId?: string;
  maxOutputTokens?: number;
  toolChoice?: { type: 'function'; function: { name: string } };
  thinking?: 'enabled' | 'disabled';
  strict?: boolean;
}

/**
 * The host-facing, non-secret portion of the provider contract.  This is
 * deliberately about the protocol we implement, not a claim that every
 * model in the provider has the same limits.  Model-specific limits are
 * optional and are only populated when the caller has verified them.
 */
export interface ProviderMetadata {
  temporaryTestSubstitute?: boolean;
  replaces?: string;
  reasoningEffort?: string;
  providerId: string;
  endpoint: string;
  model: string;
  protocol: string;
  protocolVersion: string;
  capabilities: {
    thinking: boolean;
    reasoningContent: boolean;
    toolCalls: boolean;
    toolContinuation: boolean;
    strictTools: boolean;
    structuredOutput: boolean;
    modalities: string[];
    toolDialect: string;
    opaqueState: string;
  };
  limits: {
    /** Host-requested output ceiling; this is not a provider context window. */
    maxOutputTokens: number;
    /** App Server account transport cannot request a native output token cap. */
    outputEnforcement?: 'provider' | 'host_post_completion';
    /** Verified provider input window, when supplied by an authoritative probe/config. */
    contextTokens?: number;
  };
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public retryable = false,
    public code = 'provider_error',
    public status?: number,
    public usage?: Completion['usage'],
  ) {
    super(message);
  }
}
export function friendlyError(e: unknown): string {
  if (e instanceof ProviderError) return e.message;
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError'))
    return '请求已停止或超时，请稍后重试。';
  if (e instanceof Error && e.name === 'HermesRunError')
    return 'Agent 运行引擎未完成本轮处理，请重试。若连续出现，请重新启动源码冷启动版。';
  if (e instanceof TypeError)
    return '在场内部初始化失败，请完全退出后重新启动源码冷启动版。';
  const diagnostic = e && typeof e === 'object' && 'diagnostic' in e
    ? (e as { diagnostic?: unknown }).diagnostic
    : undefined;
  if (diagnostic && typeof diagnostic === 'object') {
    const value = diagnostic as Record<string, unknown>;
    const errorCode = typeof value.errorCode === 'string' ? value.errorCode : '';
    if (errorCode === 'authentication') return 'DeepSeek API Key 无效，请在连接设置中更新后重试。';
    if (errorCode === 'quota') return 'DeepSeek 账户余额不足，请充值后重试。';
    if (errorCode === 'protocol') return 'DeepSeek 未接受 Agent 的工具调用请求，请检查模型配置后重试。';
    if (value.code === 'engine_incomplete') return 'Agent 运行引擎未完成本轮处理，请重试。若连续出现，请检查运行时安装和模型兼容性。';
  }
  return '这次处理中断了，剩余事项未完成。已有回执的操作可在安排中核对。';
}
export async function readSSE(response: Response, onData: (data: string) => void, signal?: AbortSignal) {
  if (!response.body) throw new ProviderError('DeepSeek 没有返回内容，请重试。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '',
    lines: string[] = [],
    eventId = '';
  const seen = new Set<string>();
  const emit = () => {
    if (lines.length && (!eventId || !seen.has(eventId))) {
      onData(lines.join('\n'));
      if (eventId) seen.add(eventId);
      if (seen.size > 2048) throw new ProviderError('流式事件超出本轮上限。');
    }
    lines = [];
    eventId = '';
  };
  const line = (value: string) => {
    if (!value) {
      emit();
      return;
    }
    if (value.startsWith('data:')) lines.push(value.slice(5).replace(/^ /, ''));
    else if (value.startsWith('id:')) eventId = value.slice(3).trim();
  };
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      pending += decoder.decode(value, { stream: !done });
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        const value = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        line(value);
      }
      if (pending.length > 1_000_000) throw new ProviderError('返回内容超出本次处理上限。');
      if (done) break;
    }
    if (pending) line(pending.replace(/\r$/, ''));
    emit();
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class DeepSeekClient {
  readonly capabilities = {
    providerId: 'deepseek',
    protocol: 'chat-completions',
    protocolVersion: 'v1',
    // Kept as a compatibility alias for diagnostics which previously read
    // capabilities.version; it is a protocol label, never a model name.
    version: 'chat-completions-v1',
    modalities: ['text', 'image'],
    toolDialect: 'function_calls',
    endpoint: 'https://api.deepseek.com/chat/completions',
    strictEndpoint: 'https://api.deepseek.com/beta/chat/completions',
    thinking: true,
    reasoningContent: true,
    toolCalls: true,
    toolContinuation: true,
    strictTools: true,
    // This adapter currently validates JSON locally; it does not activate a
    // provider-native response_format contract.
    structuredOutput: false,
    opaqueState: 'bounded_tool_chain',
  };
  private verifiedContextTokens?: number;
  private protocol = new WeakMap<Completion, string>();
  public readonly model = DEEPSEEK_MODEL;
  constructor(
    private key: string,
    _model: string = DEEPSEEK_MODEL,
    private fetcher: typeof fetch = fetch,
    metadata?: { contextTokens?: number },
  ) {
    // The official current multimodal route is intentionally host-owned. Old
    // saved settings and callers cannot silently select a retired alias.
    this.verifiedContextTokens = metadata?.contextTokens ?? 1_000_000;
  }
  /** Metadata is safe to persist in a run receipt: it contains no key or payload. */
  providerMetadata(options?: CompletionOptions): ProviderMetadata {
    return {
      providerId: this.capabilities.providerId,
      endpoint: options?.strict ? this.capabilities.strictEndpoint : this.capabilities.endpoint,
      model: this.model,
      protocol: this.capabilities.protocol,
      protocolVersion: this.capabilities.protocolVersion,
      capabilities: {
        thinking: this.capabilities.thinking,
        reasoningContent: this.capabilities.reasoningContent,
        toolCalls: this.capabilities.toolCalls,
        toolContinuation: this.capabilities.toolContinuation,
        strictTools: this.capabilities.strictTools,
        structuredOutput: this.capabilities.structuredOutput,
        modalities: [...this.capabilities.modalities],
        toolDialect: this.capabilities.toolDialect,
        opaqueState: this.capabilities.opaqueState,
      },
      limits: {
        maxOutputTokens: options?.maxOutputTokens || 4096,
        ...(this.verifiedContextTokens ? { contextTokens: this.verifiedContextTokens } : {}),
      },
    };
  }
  assistantMessage(result: Completion): WireMessage {
    const reasoning = this.protocol.get(result);
    return {
      role: 'assistant',
      content: result.content || null,
      ...(result.tool_calls.length ? { tool_calls: result.tool_calls } : {}),
      ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
    };
  }
  invalidateBoundary() {
    this.protocol = new WeakMap();
  }
  async complete(
    messages: ModelWireMessage[],
    tools: ToolSpec[],
    signal: AbortSignal,
    onText?: (text: string) => void,
    options?: CompletionOptions,
  ): Promise<Completion> {
    signal.throwIfAborted();
    if (options?.maxOutputTokens !== undefined && (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 256 || options.maxOutputTokens > 32768))
      throw new ProviderError('本轮输出预算不合法。');
    // Character storage is a separate bounded transport resource. Keep it
    // compatible with the declared token allowance rather than silently
    // applying the old 4K-output character cap to a 16K-output request.
    const reasoningCharacterLimit = Math.max(64000, (options?.maxOutputTokens || 4096) * 16);
    if (!this.key) throw new ProviderError('请先在连接中填写 DeepSeek API Key。');
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
      try {
        response = await this.fetcher(
          options?.strict
            ? this.capabilities.strictEndpoint
            : this.capabilities.endpoint,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: this.model,
              messages,
              ...(tools.length
                ? {
                    tools: options?.strict
                      ? tools.map((tool) => ({
                          ...tool,
                          function: {
                            ...tool.function,
                            strict: true,
                            parameters: strictDialect(tool.function.parameters),
                          },
                        }))
                      : tools,
                  }
                : {}),
              ...(options?.toolChoice ? { tool_choice: options.toolChoice } : {}),
              stream: true,
              stream_options: { include_usage: true },
              max_tokens: options?.maxOutputTokens || 4096,
              thinking: { type: options?.thinking || 'disabled' },
            }),
            signal: requestSignal,
          },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (requestSignal.aborted)
          throw new ProviderError('连接 DeepSeek 超时，请检查网络或代理后重试。', true, 'timeout');
        // Fetch transport failures are plain TypeError/DOMException values and
        // used to fall through to the generic “处理中断” message. Convert
        // them at the provider boundary without exposing URLs, headers, keys,
        // or user content.
        throw new ProviderError('无法连接 DeepSeek，请检查网络、代理或 API 地址后重试。', true, 'network');
      }
      if (response.ok) break;
      const status = response.status;
      await response.body?.cancel();
      if (status === 401) throw new ProviderError('DeepSeek API Key 无效，请在连接中更新。', false, 'authentication', status);
      if (status === 402) throw new ProviderError('DeepSeek 账户余额不足，请充值后重试。', false, 'quota', status);
      if (status === 400 || status === 404 || status === 422)
        throw new ProviderError('DeepSeek 未接受当前请求，请检查模型名称或减少输入后重试。', false, 'protocol', status);
      if (attempt === 0 && (status === 429 || status >= 500)) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          }, 1000);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        continue;
      }
      throw new ProviderError(
        status === 429 ? 'DeepSeek 当前请求较多，请稍后重试。' : 'DeepSeek 服务暂时不可用，请稍后重试。',
      );
    }
    if (!response?.ok) throw new ProviderError('DeepSeek 服务暂时不可用。');
    let content = '',
      complete = false;
    let reasoning = '';
    let outputLimited = false;
    let usage: Completion['usage'];
    const calls = new Map<number, ToolCall>();
    try {
      await readSSE(
        response,
        (data) => {
          signal.throwIfAborted();
          if (!data) return;
          if (data === '[DONE]') {
            complete = true;
            return;
          }
          let chunk: {
            choices?: {
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
              };
              finish_reason?: string;
            }[];
            error?: unknown;
            usage?: Completion['usage'];
          };
          try {
            chunk = JSON.parse(data);
          } catch {
            throw new ProviderError('DeepSeek 返回内容不完整，请重试。');
          }
          if (chunk.error) throw new ProviderError('DeepSeek 中断了本次请求，请重试。');
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (!choice) return;
          if (choice.finish_reason === 'length') {
            // Keep reading the separate usage frame, but never execute a partial
            // tool call or promote this incomplete response to a completion.
            outputLimited = true;
            return;
          }
          if (outputLimited) return;
          if (choice.finish_reason && !['stop', 'tool_calls'].includes(choice.finish_reason))
            throw new ProviderError('模型没有正常完成回复，请缩小问题后重试。');
          if (choice.finish_reason) complete = true;
          const delta = choice.delta;
          // Opaque protocol data is kept only in this bounded in-memory request chain, never serialized as memory or UI.
          if (options?.thinking === 'enabled' && delta?.reasoning_content) {
            reasoning += delta.reasoning_content;
            if (reasoning.length > reasoningCharacterLimit) throw new ProviderError('模型协议状态超过本轮上限。', false, 'protocol_budget');
          }
          if (delta?.content) {
            content += delta.content;
            if (content.length > 64000) throw new ProviderError('回复达到本次长度上限。');
            onText?.(delta.content);
          }
          for (const part of delta?.tool_calls || []) {
            if (!Number.isInteger(part.index) || part.index < 0 || part.index > 7)
              throw new ProviderError('本轮工具数量超出上限。');
            const call = calls.get(part.index) || {
              id: '',
              type: 'function' as const,
              function: { name: '', arguments: '' },
            };
            if (part.id) call.id = part.id;
            if (part.function?.name && part.function.name !== call.function.name)
              call.function.name += part.function.name;
            if (part.function?.arguments) call.function.arguments += part.function.arguments;
            if (call.function.arguments.length > 20000) throw new ProviderError('工具请求超出长度上限。');
            calls.set(part.index, call);
          }
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
        throw new ProviderError('连接 DeepSeek 超时，请检查网络或代理后重试。', true, 'timeout');
      throw new ProviderError('DeepSeek 流式连接中断，请检查网络后重试。', true, 'network');
    }
    if (outputLimited) throw new ProviderError('本次回复达到长度上限，可以请在场继续。', false, 'output_length', undefined, usage);
    if (!complete) throw new ProviderError('连接在回复完成前断开，请重试。');
    const tool_calls = [...calls.values()];
    if (options?.strict)
      for (const call of tool_calls) {
        const spec = tools.find((tool) => tool.function.name === call.function.name);
        if (spec) {
          try {
            call.function.arguments = JSON.stringify(
              normalizeStrictArguments(JSON.parse(call.function.arguments), spec.function.parameters),
            );
          } catch {
            /* Local schema rejects malformed JSON. */
          }
        }
      }
    if (tool_calls.some((c) => !c.id || !c.function.name))
      throw new ProviderError('工具请求不完整，请重试。');
    if (!content && !tool_calls.length) throw new ProviderError('DeepSeek 没有返回可用内容，请重试。');
    const result: Completion = { content, tool_calls, ...(usage ? { usage } : {}) };
    // All assistant turns belong to the provider's thinking protocol, including
    // terminal replies. Only a host boundary change clears the opaque chain.
    // WeakMap keeps this out of ordinary messages, memory, UI and JSON reports.
    if (options?.thinking === 'enabled') this.protocol.set(result, reasoning);
    return result;
  }
}

// DeepSeek strict beta has a narrower schema dialect. Local Zod validation remains authoritative.
export function strictDialect(input: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown): any => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      if (['$schema', 'minLength', 'maxLength', 'minItems', 'maxItems'].includes(key)) continue;
      if (key === 'format' && !['email', 'hostname', 'ipv4', 'ipv6', 'uuid'].includes(String(item))) continue;
      if (key === 'oneOf') {
        result.anyOf = walk(item);
        continue;
      }
      if (key === '$defs') {
        result.$def = walk(item);
        continue;
      }
      if (key === '$ref' && typeof item === 'string') {
        result.$ref = item.replace('#/$defs/', '#/$def/');
        continue;
      }
      if (key === 'const' && typeof item !== 'number') {
        result.enum = [item];
        continue;
      }
      result[key] = walk(item);
    }
    if (result.type === 'object') {
      if (!result.properties && result.additionalProperties)
        throw new ProviderError('当前工具包含开放字段，不能等价转换为 strict 方言；请使用普通工具模式。');
      const required = new Set(Array.isArray(result.required) ? result.required : []);
      result.properties ||= {};
      for (const key of Object.keys(result.properties))
        if (!required.has(key))
          result.properties[key] = { anyOf: [result.properties[key], { type: 'null' }] };
      result.required = Object.keys(result.properties);
      result.additionalProperties = false;
    }
    return result;
  };
  return walk(input);
}

function normalizeStrictArguments(value: any, schema: any): any {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => normalizeStrictArguments(item, schema.items || {}));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const property = schema.properties?.[key] || {};
    const permitsNull =
      property.type === 'null' ||
      (Array.isArray(property.type) && property.type.includes('null')) ||
      property.anyOf?.some((part: any) => part.type === 'null');
    if (item === null && !(schema.required || []).includes(key) && schema.properties?.[key] && !permitsNull)
      continue;
    result[key] = normalizeStrictArguments(item, property);
  }
  return result;
}
