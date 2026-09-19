import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { MobileLanguage } from './types';

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
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询当前位置或浙江大学紫金港校区的当前天气和未来五天预报。用户询问天气、温度、下雨、穿衣或户外活动建议时使用。手机定位不可用时使用校园参考位置，并明确说明位置是参考值。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_campus_map',
      description: '在手机内置的浙江大学紫金港校园地图中搜索建筑、地点和地标名称。用户询问某栋楼在哪里、某地点坐标或校园地点时使用；只返回本地地图中确实存在的结果。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '用户要查找的建筑或地点名称' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan_campus_route',
      description: '使用手机内置校园步行路网规划两个已知地点之间的路线。只有用户明确询问路线、怎么走或步行距离时使用。',
      parameters: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: '起点名称；如果是当前位置可写当前位置' },
          destination: { type: 'string', description: '终点名称' },
        },
        required: ['origin', 'destination'],
        additionalProperties: false,
      },
    },
  },
];

function apiErrorMessage(payload: unknown): string | undefined {
  let value = payload;
  if (typeof payload === 'string') {
    try {
      value = JSON.parse(payload);
    } catch {
      const plain = payload.replace(/\s+/g, ' ').trim();
      return plain ? plain.slice(0, 240) : undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const body = value as { error?: unknown; message?: unknown };
  if (typeof body.error === 'string') return body.error.slice(0, 240);
  if (body.error && typeof body.error === 'object') {
    const message = (body.error as { message?: unknown }).message;
    if (typeof message === 'string') return message.slice(0, 240);
  }
  return typeof body.message === 'string' ? body.message.slice(0, 240) : undefined;
}

function errorFromStatus(status: number, payload?: unknown): DeepSeekError {
  const detail = apiErrorMessage(payload);
  if (status === 401) return new DeepSeekError('DeepSeek API Key 无效，请在设置中更新。', 'authentication');
  if (status === 402) return new DeepSeekError('DeepSeek 账户余额不足，请充值后重试。', 'quota');
  if (status === 429) return new DeepSeekError('DeepSeek 当前请求较多，请稍后重试。', 'busy');
  if (status === 400 || status === 404 || status === 422) {
    return new DeepSeekError(
      detail ? `DeepSeek 拒绝了请求：${detail}` : 'DeepSeek 未接受当前请求，请检查输入或模型配置。',
      'protocol',
    );
  }
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

function completionFromJson(payload: unknown, onText?: (text: string) => void): DeepSeekCompletion {
  let body: unknown;
  try {
    body = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    throw new DeepSeekError('DeepSeek 返回内容不是有效 JSON，请重试。', 'protocol');
  }
  if (!body || typeof body !== 'object')
    throw new DeepSeekError('DeepSeek 返回内容不完整，请重试。', 'protocol');
  const value = body as {
    error?: unknown;
    usage?: DeepSeekCompletion['usage'];
    choices?: Array<{ message?: DeepSeekMessage }>;
  };
  if (value.error)
    throw new DeepSeekError(
      apiErrorMessage(value) ? `DeepSeek 拒绝了请求：${apiErrorMessage(value)}` : 'DeepSeek 中断了本次回复，请重试。',
      'protocol',
    );
  const message = value.choices?.[0]?.message;
  if (!message || message.role !== 'assistant')
    throw new DeepSeekError('DeepSeek 没有返回可用回复，请重试。', 'protocol');
  if (message.content) onText?.(message.content);
  return { message, usage: value.usage };
}

async function completeNative(
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onText?: (text: string) => void,
): Promise<DeepSeekCompletion> {
  signal.throwIfAborted();
  let result: Awaited<ReturnType<typeof CapacitorHttp.post>>;
  try {
    const nativeBody: Record<string, unknown> = { ...body, stream: false };
    delete nativeBody.stream_options;
    result = await CapacitorHttp.post({
      url: DEEPSEEK_ENDPOINT,
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
      data: nativeBody,
      responseType: 'json',
      connectTimeout: 20_000,
      readTimeout: 90_000,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new DeepSeekError('无法连接 DeepSeek，请检查网络或代理设置。', 'network');
  }
  signal.throwIfAborted();
  if (result.status < 200 || result.status >= 300) throw errorFromStatus(result.status, result.data);
  return completionFromJson(result.data, onText);
}

export async function completeDeepSeek(
  apiKey: string,
  messages: DeepSeekMessage[],
  signal: AbortSignal,
  tools: DeepSeekToolSpec[] = LOCAL_TOOL_SPECS,
  onText?: (text: string) => void,
): Promise<DeepSeekCompletion> {
  if (!apiKey.trim()) throw new DeepSeekError('请先在设置中填写 DeepSeek API Key。', 'authentication');
  const requestBody = {
    model: DEEPSEEK_MODEL,
    messages,
    ...(tools.length ? { tools } : {}),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 4096,
    thinking: { type: 'disabled' },
  };
  if (Capacitor.isNativePlatform()) return completeNative(apiKey, requestBody, signal, onText);
  let response: Response;
  try {
    response = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new DeepSeekError('连接 DeepSeek 超时，请检查网络后重试。', 'timeout');
    throw new DeepSeekError('无法连接 DeepSeek，请检查网络或代理设置。', 'network');
  }
  if (!response.ok) {
    const errorPayload = await response.text().catch(() => '');
    throw errorFromStatus(response.status, errorPayload);
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
          if (payload.error)
            throw new DeepSeekError(
              apiErrorMessage(payload) ? `DeepSeek 拒绝了请求：${apiErrorMessage(payload)}` : 'DeepSeek 中断了本次回复，请重试。',
              'protocol',
            );
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

export async function translateText(
  apiKey: string,
  text: string,
  targetLanguage: MobileLanguage,
  signal: AbortSignal,
): Promise<string> {
  if (!text.trim()) return text;
  const languageName = targetLanguage === 'en' ? 'English' : targetLanguage === 'zh-TW' ? '繁體中文' : '简体中文';
  const completion = await completeDeepSeek(
    apiKey,
    [
      {
        role: 'system',
        content: `请将用户提供的内容翻译成${languageName}。只返回翻译后的正文，不要解释，不要添加前缀。保留原有的换行、列表、Markdown 标记和语气。`,
      },
      { role: 'user', content: text },
    ],
    signal,
    [],
  );
  return completion.message.content?.trim() || text;
}
