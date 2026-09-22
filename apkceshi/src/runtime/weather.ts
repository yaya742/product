import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { isMobileVmLocationAvailable, isMobileVmOffline, isMobileVmSession, mobileVmLocation } from './mobileVm';
import type { MobileLanguage } from './types';
import type { MapCoordinate } from './map';

export const WEATHER_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
export const GEOCODING_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
export const CAMPUS_COORDINATE: MapCoordinate = [120.07665, 30.30513];

export interface WeatherSnapshot {
  latitude: number;
  longitude: number;
  timezone: string;
  current: {
    time: string;
    temperature: number;
    apparentTemperature: number;
    humidity: number;
    weatherCode: number;
    windSpeed: number;
    precipitation: number;
    isDay: boolean;
  };
  hourly: Array<{
    time: string;
    temperature: number;
    weatherCode: number;
    precipitationProbability: number;
    precipitation: number;
  }>;
  daily: Array<{
    date: string;
    weatherCode: number;
    max: number;
    min: number;
    precipitationProbability: number;
  }>;
}

export interface DeviceLocation {
  coordinate: MapCoordinate;
  accuracy: number;
}

export interface WeatherLocation {
  name: string;
  displayName: string;
  coordinate: MapCoordinate;
  timezone?: string;
}

export function readDeviceLocation(signal?: AbortSignal): Promise<DeviceLocation> {
  if (isMobileVmSession()) {
    if (!isMobileVmLocationAvailable()) return Promise.reject(new Error('虚拟机已模拟定位不可用。'));
    if (signal?.aborted) return Promise.reject(new DOMException('定位已取消。', 'AbortError'));
    const location = mobileVmLocation();
    return Promise.resolve({ coordinate: [location.longitude, location.latitude], accuracy: location.accuracy });
  }
  if (!navigator.geolocation) return Promise.reject(new Error('当前设备不支持定位。'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new DOMException('定位已取消。', 'AbortError')));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    navigator.geolocation.getCurrentPosition(
      (position) => finish(() => resolve({
        coordinate: [position.coords.longitude, position.coords.latitude],
        accuracy: position.coords.accuracy,
      })),
      (error) => finish(() => reject(new Error(error.message || '无法获取当前位置。'))),
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000 },
    );
  });
}

export async function fetchWeather(coordinate: MapCoordinate, signal?: AbortSignal): Promise<WeatherSnapshot> {
  if (isMobileVmOffline()) throw new Error('虚拟机已模拟断网，天气请求未发送。');
  const params = new URLSearchParams({
    latitude: coordinate[1].toFixed(6),
    longitude: coordinate[0].toFixed(6),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability,precipitation',
    forecast_hours: '24',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    forecast_days: '5',
    timezone: 'auto',
  });
  const url = `${WEATHER_ENDPOINT}?${params.toString()}`;
  let status = 200;
  const body = await requestJson(url, signal) as { error?: boolean; reason?: string; current?: Record<string, unknown>; hourly?: Record<string, unknown>; daily?: Record<string, unknown>; latitude?: number; longitude?: number; timezone?: string; __status?: number };
  status = body.__status || status;
  if (status < 200 || status >= 300 || body.error || !body.current || !body.hourly || !body.daily) throw new Error(body.reason || `天气服务返回 ${status}`);
  const current = body.current;
  const hourly = body.hourly;
  const daily = body.daily;
  const dates = Array.isArray(daily.time) ? daily.time : [];
  const codes = Array.isArray(daily.weather_code) ? daily.weather_code : [];
  const max = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
  const min = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
  const rain = Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max : [];
  const hourlyTimes = Array.isArray(hourly.time) ? hourly.time : [];
  const hourlyTemperature = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
  const hourlyCodes = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];
  const hourlyProbability = Array.isArray(hourly.precipitation_probability) ? hourly.precipitation_probability : [];
  const hourlyPrecipitation = Array.isArray(hourly.precipitation) ? hourly.precipitation : [];
  const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    latitude: number(body.latitude, coordinate[1]),
    longitude: number(body.longitude, coordinate[0]),
    timezone: typeof body.timezone === 'string' ? body.timezone : 'auto',
    current: {
      time: typeof current.time === 'string' ? current.time : new Date().toISOString(),
      temperature: number(current.temperature_2m),
      apparentTemperature: number(current.apparent_temperature),
      humidity: number(current.relative_humidity_2m),
      weatherCode: number(current.weather_code),
      windSpeed: number(current.wind_speed_10m),
      precipitation: number(current.precipitation),
      isDay: number(current.is_day, 1) === 1,
    },
    hourly: hourlyTimes.map((time, index) => ({
      time: String(time),
      temperature: number(hourlyTemperature[index]),
      weatherCode: number(hourlyCodes[index]),
      precipitationProbability: number(hourlyProbability[index]),
      precipitation: number(hourlyPrecipitation[index]),
    })),
    daily: dates.map((date, index) => ({
      date: String(date),
      weatherCode: number(codes[index]),
      max: number(max[index]),
      min: number(min[index]),
      precipitationProbability: number(rain[index]),
    })),
  };
}

type JsonResponse = Record<string, unknown> & { __status?: number };

async function requestJson(url: string, signal?: AbortSignal): Promise<JsonResponse> {
  if (isMobileVmOffline()) throw new Error('虚拟机已模拟断网，网络请求未发送。');
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({ url, responseType: 'json', connectTimeout: 15_000, readTimeout: 20_000 });
    const data = (typeof response.data === 'string' ? JSON.parse(response.data) : response.data) as JsonResponse;
    return { ...data, __status: response.status };
  }
  const response = await fetch(url, { signal });
  const data = await response.json().catch(() => ({})) as JsonResponse;
  return { ...data, __status: response.status };
}

export async function searchWeatherLocations(query: string, signal?: AbortSignal): Promise<WeatherLocation[]> {
  const params = new URLSearchParams({ name: query.trim(), count: '6', language: 'zh', format: 'json' });
  const body = await requestJson(`${GEOCODING_ENDPOINT}?${params.toString()}`, signal);
  const results = Array.isArray(body.results) ? body.results : [];
  return results.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    if (typeof value.name !== 'string' || typeof value.latitude !== 'number' || typeof value.longitude !== 'number') return [];
    const parts = [value.name, value.admin1, value.country].filter((part): part is string => typeof part === 'string' && !!part);
    return [{
      name: value.name,
      displayName: parts.join(' · '),
      coordinate: [value.longitude, value.latitude] as MapCoordinate,
      timezone: typeof value.timezone === 'string' ? value.timezone : undefined,
    }];
  });
}

function isRainHour(hour: WeatherSnapshot['hourly'][number]): boolean {
  return hour.precipitation > 0.05 || hour.precipitationProbability >= 40 || (hour.weatherCode >= 51 && hour.weatherCode !== 71 && hour.weatherCode !== 73 && hour.weatherCode !== 75 && hour.weatherCode !== 77 && hour.weatherCode < 90) || hour.weatherCode >= 95;
}

export function rainIntervals(snapshot: WeatherSnapshot, language: MobileLanguage): string[] {
  const intervals: Array<{ start: string; end: string }> = [];
  let active: { start: string; end: string } | undefined;
  for (const hour of snapshot.hourly) {
    const rain = isRainHour(hour);
    const end = new Date(new Date(hour.time).getTime() + 60 * 60 * 1000).toISOString();
    if (rain && !active) active = { start: hour.time, end };
    else if (rain && active) active.end = end;
    else if (active) { intervals.push(active); active = undefined; }
  }
  if (active) intervals.push(active);
  const locale = language === 'en' ? 'en-US' : language;
  return intervals.slice(0, 4).map((interval) => {
    const start = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(interval.start));
    const end = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(interval.end));
    return language === 'en' ? `${start}–${end} rain likely` : language === 'zh-TW' ? `${start}–${end} 可能有雨` : `${start}–${end} 可能有雨`;
  });
}

export function weatherCodeText(code: number, language: MobileLanguage): string {
  const english = language === 'en';
  const traditional = language === 'zh-TW';
  if (code === 0) return english ? 'Clear sky' : traditional ? '晴朗' : '晴朗';
  if (code <= 3) return english ? 'Partly cloudy' : traditional ? '局部多雲' : '局部多云';
  if (code === 45 || code === 48) return english ? 'Fog' : traditional ? '霧' : '雾';
  if (code >= 51 && code <= 57) return english ? 'Drizzle' : traditional ? '毛毛雨' : '毛毛雨';
  if (code >= 61 && code <= 67) return english ? 'Rain' : traditional ? '降雨' : '降雨';
  if (code >= 71 && code <= 77) return english ? 'Snow' : traditional ? '降雪' : '降雪';
  if (code >= 80 && code <= 82) return english ? 'Rain showers' : traditional ? '陣雨' : '阵雨';
  if (code >= 85 && code <= 86) return english ? 'Snow showers' : traditional ? '陣雪' : '阵雪';
  if (code >= 95) return english ? 'Thunderstorm' : traditional ? '雷暴' : '雷暴';
  return english ? 'Unknown' : traditional ? '未知' : '未知';
}

export function formatWeatherDay(date: string, language: MobileLanguage): string {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : language, { weekday: 'short', month: 'numeric', day: 'numeric' }).format(new Date(`${date}T12:00:00`));
}
