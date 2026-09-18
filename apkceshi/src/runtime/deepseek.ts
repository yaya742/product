export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-flash';

export type DeepSeekRole = 'system' | 'user' | 'assistant' | 'tool';

export interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface DeepSeekMessage {
  role: DeepSeekRole;
  content: string | null;
  tool_calls?: DeepSeekToolCall[];
  tool_call_id?: string;
}

export interface DeepSeekToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface DeepSeekCompletion {
  message: DeepSeekMessage;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly code: 'authentication' | 'quota' | 'network' | 'timeout' | 'protocol' | 'busy' = 'protocol',
  ) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

export const LOCAL_TOOL_SPECS: DeepSeekToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'get_local_time',
      description: '读取手机当前本地时间。只在用户询问当前时间、日期或相对时间时使用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_device_location',
      description: '读取手机当前一次性定位。只有用户的问题确实需要当前位置时使用，并说明定位可能被拒绝或不精确。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

function errorFromStatus(status: number): DeepSeekError {
  if (status === 401) return new DeepSeekError('DeepSeek API Key 无效，请在设置中更新。', 'authentication');
  if (status === 402) return new DeepSeekError('DeepSeek 账户余额不足，请充值后重试。', 'quota');
  if (status === 429) return new DeepSeekError('DeepSeek 当前请求较多，请稍后重试。', 'busy');
  if (status === 400 || status === 404 || status === 422)
    return new DeepSeekError('DeepSeek 未接受当前请求，请检查输入或模型配置。', 'protocol');
  return new DeepSeekError('DeepSeek 服务暂时不可用，请稍后重试。', 'busy');
}

function parseSseEvent(raw: string): unknown | '[DONE]' | null {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  if (data === '[DONE]') return '[DONE]';
  try {
    return JSON.parse(data);
  } catch {
    throw new DeepSeekError('DeepSeek 返回内容不完整，请重试。', 'protocol');
  }
}

export async function completeDeepSeek(
  apiKey: string,
  messages: DeepSeekMessage[],
  signal: AbortSignal,
  tools: DeepSeekToolSpec[] = LOCAL_TOOL_SPECS,
  onText?: (text: string) => void,
): Promise<DeepSeekCompletion> {
  if (!apiKey.trim()) throw new DeepSeekError('请先在设置中填写 DeepSeek API Key。', 'authentication');
  let response: Response;
  try {
    response = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        ...(tools.length ? { tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 4096,
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new DeepSeekError('连接 DeepSeek 超时，请检查网络后重试。', 'timeout');
    throw new DeepSeekError('无法连接 DeepSeek，请检查网络或代理设置。', 'network');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw errorFromStatus(response.status);
  }
  if (!response.body) throw new DeepSeekError('DeepSeek 没有返回内容，请重试。', 'protocol');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  let usage: DeepSeekCompletion['usage'];
  let done = false;
  const calls = new Map<number, DeepSeekToolCall>();
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.value) pending += decoder.decode(chunk.value, { stream: !chunk.done });
      if (pending.length > 2_000_000) throw new DeepSeekError('本次回复超过手机端上限。', 'protocol');
      let boundary = pending.indexOf('\n\n');
      while (boundary >= 0) {
        const raw = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const event = parseSseEvent(raw);
        if (event === '[DONE]') {
          done = true;
          break;
        }
        if (event && typeof event === 'object') {
          const payload = event as {
            error?: unknown;
            usage?: DeepSeekCompletion['usage'];
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };
          if (payload.error) throw new DeepSeekError('DeepSeek 中断了本次回复，请重试。', 'protocol');
          if (payload.usage) usage = payload.usage;
          const delta = payload.choices?.[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            onText?.(delta.content);
          }
          for (const part of delta?.tool_calls || []) {
            if (!Number.isInteger(part.index) || part.index < 0 || part.index > 7)
              throw new DeepSeekError('本轮工具数量超出手机端上限。', 'protocol');
            const call = calls.get(part.index) || {
              id: '',
              type: 'function' as const,
              function: { name: '', arguments: '' },
            };
            if (part.id) call.id = part.id;
            if (part.function?.name) call.function.name += part.function.name;
            if (part.function?.arguments) call.function.arguments += part.function.arguments;
            calls.set(part.index, call);
          }
        }
        boundary = pending.indexOf('\n\n');
      }
      if (chunk.done) {
        if (pending.trim()) {
          const event = parseSseEvent(pending);
          if (event === '[DONE]') done = true;
        }
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return {
    message: {
      role: 'assistant',
      content: content || null,
      ...(calls.size ? { tool_calls: [...calls.values()] } : {}),
    },
    usage,
  };
}

export async function testDeepSeekConnection(apiKey: string, signal: AbortSignal): Promise<void> {
  await completeDeepSeek(
    apiKey,
    [
      { role: 'system', content: '只回复“连接成功”。' },
      { role: 'user', content: '测试连接。' },
    ],
    signal,
    [],
  );
}
