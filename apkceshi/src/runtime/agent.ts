import { buildSystemPrompt } from './prompt';
import {
  completeDeepSeek,
  type DeepSeekMessage,
  type DeepSeekToolCall,
  DeepSeekError,
} from './deepseek';
import { findWalkingRoute, loadMapData } from './map';
import { CAMPUS_COORDINATE, fetchWeather, readDeviceLocation } from './weather';
import type { MobileLanguage, MobileMessage } from './types';

export type AgentStatus = '联系 DeepSeek' | '读取手机时间' | '请求手机定位' | '查询天气' | '查询校园地图' | '规划路线' | '整理回复';

function modelHistory(messages: MobileMessage[]): DeepSeekMessage[] {
  return messages
    .filter((message) => message.status !== 'running')
    .slice(-32)
    .map((message) => ({ role: message.role, content: message.content }));
}

function readLocation(signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!navigator.geolocation)
    return Promise.resolve({ status: 'unavailable', reason: '当前设备没有提供定位能力。' });
  return new Promise((resolve) => {
    const onAbort = () => resolve({ status: 'cancelled', reason: '用户停止了本轮定位。' });
    signal.addEventListener('abort', onAbort, { once: true });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        signal.removeEventListener('abort', onAbort);
        resolve({
          status: 'ok',
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy_m: position.coords.accuracy,
          captured_at: new Date(position.timestamp).toISOString(),
          note: '这是一次性设备定位，不会由本地运行时自动写入长期记忆。',
        });
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ status: 'unavailable', reason: error.message || '设备没有返回当前位置。' });
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000 },
    );
  });
}

async function runLocalTool(call: DeepSeekToolCall, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (call.function.name === 'get_local_time') {
    return {
      status: 'ok',
      iso: new Date().toISOString(),
      local: new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(new Date()),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }
  if (call.function.name === 'get_device_location') return runLocalToolLocation(signal);
  if (call.function.name === 'get_weather') {
    let coordinate = CAMPUS_COORDINATE;
    let locationSource = '浙江大学紫金港校区参考位置';
    try {
      const location = await readDeviceLocation(signal);
      coordinate = location.coordinate;
      locationSource = `手机定位（误差约 ${Math.round(location.accuracy)} 米）`;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    const weather = await fetchWeather(coordinate, signal);
    return {
      status: 'ok',
      location_source: locationSource,
      coordinates: coordinate,
      timezone: weather.timezone,
      current: weather.current,
      hourly: weather.hourly,
      daily: weather.daily,
    };
  }
  if (call.function.name === 'search_campus_map') {
    const args = toolArguments(call);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { status: 'unavailable', reason: '没有提供要搜索的校园地点名称。' };
    const data = await loadMapData(signal);
    const needle = query.toLowerCase();
    const matches = data.places
      .filter((place) => [place.displayName, ...place.aliases].some((value) => value.toLowerCase().includes(needle)))
      .slice(0, 8);
    return {
      status: matches.length ? 'ok' : 'not_found',
      query,
      matches: matches.map((place) => ({
        name: place.displayName,
        aliases: place.aliases,
        kind: place.kind,
        coordinate: place.coordinate,
      })),
      reason: matches.length ? undefined : '本地校园地图没有找到这个名称，不能猜测建筑位置。',
    };
  }
  if (call.function.name === 'plan_campus_route') {
    const args = toolArguments(call);
    const originQuery = typeof args.origin === 'string' ? args.origin.trim() : '';
    const destinationQuery = typeof args.destination === 'string' ? args.destination.trim() : '';
    if (!originQuery || !destinationQuery) return { status: 'unavailable', reason: '请提供起点和终点。' };
    const data = await loadMapData(signal);
    async function resolvePlace(query: string) {
      if (query === '当前位置' || query.toLowerCase() === 'current location') {
        const current = await readDeviceLocation(signal);
        return { name: '当前位置', coordinate: current.coordinate };
      }
      const needle = query.toLowerCase();
      const match = data.places.find((place) => [place.displayName, ...place.aliases].some((value) => value.toLowerCase() === needle))
        || data.places.find((place) => [place.displayName, ...place.aliases].some((value) => value.toLowerCase().includes(needle)));
      return match ? { name: match.displayName, coordinate: match.coordinate } : undefined;
    }
    const origin = await resolvePlace(originQuery);
    const destination = await resolvePlace(destinationQuery);
    if (!origin || !destination) {
      return {
        status: 'not_found',
        origin: originQuery,
        destination: destinationQuery,
        reason: '起点或终点不在本地校园地图中。',
      };
    }
    const route = findWalkingRoute(data, origin.coordinate, destination.coordinate);
    return route
      ? { status: 'ok', origin: origin.name, destination: destination.name, distance_m: Math.round(route.meters), coordinates: route.coordinates }
      : { status: 'unavailable', origin: origin.name, destination: destination.name, reason: '本地步行路网没有找到连通路线。' };
  }
  return { status: 'unavailable', reason: '手机端没有提供这项能力。' };
}

function toolArguments(call: DeepSeekToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function runLocalToolLocation(signal: AbortSignal): Promise<Record<string, unknown>> {
  return readLocation(signal);
}

export async function runMobileAgent(
  apiKey: string,
  messages: MobileMessage[],
  userText: string,
  memories: string[],
  language: MobileLanguage,
  signal: AbortSignal,
  onText: (text: string) => void,
  onStatus: (status: AgentStatus) => void,
): Promise<string> {
  const wire: DeepSeekMessage[] = [
    { role: 'system', content: buildSystemPrompt(memories, language) },
    ...modelHistory(messages),
    { role: 'user', content: userText },
  ];
  for (let round = 0; round < 6; round++) {
    signal.throwIfAborted();
    onStatus(round === 0 ? '联系 DeepSeek' : '整理回复');
    let streamedText = '';
    const completion = await completeDeepSeek(apiKey, wire, signal, undefined, (text) => {
      streamedText += text;
      onText(text);
    });
    wire.push(completion.message);
    if (!completion.message.tool_calls?.length) return streamedText || completion.message.content || '这次没有返回可显示的内容。';

    for (const call of completion.message.tool_calls) {
      signal.throwIfAborted();
      onStatus(
        call.function.name === 'get_local_time'
          ? '读取手机时间'
          : call.function.name === 'get_weather'
            ? '查询天气'
            : call.function.name === 'search_campus_map'
              ? '查询校园地图'
              : call.function.name === 'plan_campus_route'
                ? '规划路线'
                : '请求手机定位',
      );
      let result: Record<string, unknown>;
      try {
        result = await runLocalTool(call, signal);
      } catch (error) {
        result = {
          status: 'unavailable',
          reason: error instanceof Error ? error.message : '手机能力调用失败。',
        };
      }
      wire.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: call.id });
    }
  }
  throw new DeepSeekError('本轮工具处理次数达到上限，请把问题说得更具体一些。', 'protocol');
}
