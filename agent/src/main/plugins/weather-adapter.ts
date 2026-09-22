import type { KnowledgeStatus, ScopeHandle } from '../../shared/harness';
import type { PolicyKernel } from '../runtime/policy';
import type { BuiltinConnections } from '../capabilities/builtin';

export interface WeatherPluginInput {
  days: number;
  location: 'current' | 'Hangzhou';
  [key: string]: unknown;
}

export type WeatherInputPreparation =
  | { input: WeatherPluginInput }
  | { result: { status: KnowledgeStatus; sourceId: string; reason: string; simulated: false } };

/**
 * The host owns OS location access. It enriches an otherwise portable weather
 * plugin request with coordinates, without making the plugin depend on
 * Windows APIs or exposing the raw coordinate in the returned result.
 */
export async function prepareWeatherPluginInput(
  input: WeatherPluginInput,
  options: {
    policy: PolicyKernel;
    scope: ScopeHandle;
    connections: BuiltinConnections;
    signal: AbortSignal;
    sourceId?: string;
  },
): Promise<WeatherInputPreparation> {
  const sourceId = options.sourceId || 'plugin:weather';
  if (input.location !== 'current') return { input };
  options.policy.require(options.scope, 'location:read');
  if (!options.connections.location || !options.connections.map)
    return {
      result: {
        status: 'not_connected',
        sourceId,
        reason: '本机定位接口尚未连接。请关闭“使用本机位置”，或先连接 Windows 定位。',
        simulated: false,
      },
    };
  const located = await options.connections.location.read(options.connections.map.overview());
  options.signal.throwIfAborted();
  const fix = located.fix;
  if (!fix || !['fresh', 'approximate', 'outside'].includes(located.status))
    return {
      result: {
        status: 'unknown',
        sourceId,
        reason: `${located.reason} 天气没有改用杭州坐标，也没有继续发起查询。`,
        simulated: false,
      },
    };
  const [longitude, latitude] = fix.coordinate;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)
    return {
      result: {
        status: 'unknown',
        sourceId,
        reason: '本机定位返回了无效坐标，天气没有继续查询。',
        simulated: false,
      },
    };
  const enriched: WeatherPluginInput = {
    ...input,
    latitude,
    longitude,
    locationSource: 'windows_location',
    locationLabel: Number.isFinite(fix.accuracy)
      ? `当前位置（Windows 定位，精度约 ${Math.max(0, Math.round(fix.accuracy!))} 米）`
      : '当前位置（Windows 定位）',
  };
  if (Number.isFinite(fix.accuracy)) enriched.accuracy_m = Math.max(0, Math.round(fix.accuracy!));
  return { input: enriched };
}
