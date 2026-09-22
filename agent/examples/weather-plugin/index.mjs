const SOURCE_ID = 'plugin:weather';
const API = 'https://api.open-meteo.com/v1/forecast';
const DEFAULT_COORDINATE = { latitude: 30.2741, longitude: 120.1551 };
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

function coordinates(args) {
  const hasLatitude = args?.latitude !== undefined;
  const hasLongitude = args?.longitude !== undefined;
  const latitude = args?.latitude;
  const longitude = args?.longitude;
  if (args?.location === 'current' && (!Number.isFinite(latitude) || !Number.isFinite(longitude)))
    return { error: '当前位置天气缺少宿主提供的有效坐标。' };
  if (hasLatitude !== hasLongitude) return { error: '天气查询必须同时提供纬度和经度。' };
  if (hasLatitude && (!Number.isFinite(latitude) || !Number.isFinite(longitude)))
    return { error: '天气查询坐标无效。' };
  const resolved = hasLatitude
    ? { latitude, longitude }
    : { latitude: DEFAULT_COORDINATE.latitude, longitude: DEFAULT_COORDINATE.longitude };
  if (resolved.latitude < -90 || resolved.latitude > 90 || resolved.longitude < -180 || resolved.longitude > 180)
    return { error: '天气查询坐标超出有效范围。' };
  return resolved;
}

function locationLabel(args) {
  if (typeof args?.locationLabel === 'string' && args.locationLabel) return args.locationLabel;
  return args?.location === 'current' ? '当前位置（插件收到的宿主定位）' : '杭州城市参考坐标（非用户定位）';
}

async function getWeather(args, context, query) {
  const location = coordinates(args);
  if (location.error) return { error: location.error };
  const { latitude, longitude } = location;
  const timeZone = typeof args?.timeZone === 'string' && args.timeZone ? args.timeZone : DEFAULT_TIME_ZONE;
  const url = new URL(API);
  url.search = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), timezone: timeZone, ...query }).toString();
  try {
    const response = await context.request(url.toString());
    if (!response.ok) return { error: `天气服务返回 HTTP ${response.status}。` };
    const data = await response.json();
    if (!data || typeof data !== 'object') return { error: '天气服务返回了无效数据。' };
    return { data, timeZone };
  } catch {
    return { error: '暂时无法连接天气服务，请稍后重试。' };
  }
}

function failure(reason) {
  return { status: 'failed', sourceId: SOURCE_ID, reason, simulated: false };
}

export default {
  async invoke({ name, args, context }) {
    if (name === 'weather.lookup') {
      const result = await getWeather(args, context, {
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        forecast_days: String(args.days),
      });
      if (result.error) return failure(result.error);
      if (!result.data.current || !result.data.daily?.time?.length)
        return failure('天气服务没有返回完整的当前天气和日预报。');
      return {
        status: 'fresh',
        sourceId: SOURCE_ID,
        data: {
          location: locationLabel(args),
          timeZone: result.timeZone,
          current: result.data.current,
          forecast: result.data.daily,
        },
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        coverage: { complete: true, scope: `${locationLabel(args)}未来 ${args.days} 天`, until: result.data.daily.time?.at(-1) },
        simulated: false,
      };
    }

    if (name === 'weather.forecast' || name === 'weather.outdoor_activity') {
      const hours = args.hours;
      const result = await getWeather(args, context, {
        hourly: 'weather_code,temperature_2m,precipitation_probability,precipitation,wind_speed_10m',
        forecast_hours: String(hours),
      });
      if (result.error) return failure(result.error);
      if (!result.data.hourly) return failure('天气服务没有返回逐小时预报。');
      if (name === 'weather.forecast')
        return {
          status: 'fresh',
          sourceId: SOURCE_ID,
          data: { location: locationLabel(args), timeZone: result.timeZone, hourly: result.data.hourly },
          fetchedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 900000).toISOString(),
          coverage: { complete: true, scope: `${locationLabel(args)}未来 ${hours} 小时`, until: result.data.hourly.time?.at(-1) },
          simulated: false,
        };

      const hourly = result.data.hourly;
      const rainProbability = Math.max(...(hourly.precipitation_probability || []), 0);
      const precipitation = Math.max(...(hourly.precipitation || []), 0);
      const wind = Math.max(...(hourly.wind_speed_10m || []), 0);
      const temperatures = hourly.temperature_2m || [];
      const minTemperature = temperatures.length ? Math.min(...temperatures) : undefined;
      const maxTemperature = temperatures.length ? Math.max(...temperatures) : undefined;
      const reasons = [];
      if (rainProbability >= 60 || precipitation >= 2) reasons.push(`降水风险较高（概率 ${Math.round(rainProbability)}%）`);
      if (wind >= 35) reasons.push(`最大风速约 ${Math.round(wind)} km/h`);
      if (minTemperature !== undefined && minTemperature < 5) reasons.push(`最低温度约 ${Math.round(minTemperature)}°C`);
      if (maxTemperature !== undefined && maxTemperature > 35) reasons.push(`最高温度约 ${Math.round(maxTemperature)}°C`);
      const status = rainProbability >= 80 || precipitation >= 8 || wind >= 55 ? 'avoid' : reasons.length ? 'caution' : 'go';
      return {
        status: 'fresh',
        sourceId: SOURCE_ID,
        data: {
          activity: args.activity || '户外活动',
          status,
          statusText: status === 'go' ? '条件较适合' : status === 'caution' ? '可以进行，但建议做好准备' : '不建议进行',
          reasons: reasons.length ? reasons : ['预报窗口内未发现明显天气风险'],
          window: { hours, location: locationLabel(args), minTemperature, maxTemperature, rainProbability, precipitation, wind },
        },
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        coverage: { complete: true, scope: `${locationLabel(args)}未来 ${hours} 小时户外活动窗口`, until: hourly.time?.at(-1) },
        simulated: false,
      };
    }

    return failure(`天气插件不支持能力 ${name}。`);
  },
};
