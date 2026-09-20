export interface WeatherCurrentSnapshot {
  temperature_2m?: number;
  apparent_temperature?: number;
  relative_humidity_2m?: number;
  precipitation?: number;
  weather_code?: number | string;
  wind_speed_10m?: number;
  is_day?: number | boolean;
}

export interface WeatherDailySnapshot {
  time: string[];
  weather_code?: Array<number | string>;
  temperature_2m_max?: number[];
  temperature_2m_min?: number[];
  precipitation_probability_max?: number[];
}

export interface WeatherCard {
  schemaVersion: 'weather-card/v1';
  kind: 'weather';
  status: 'fresh' | 'stale';
  location: string;
  timeZone: string;
  current: WeatherCurrentSnapshot;
  forecast: WeatherDailySnapshot;
  source: string;
  fetchedAt: string;
  warnings: string[];
}

export function weatherConditionText(code: number | string | undefined): string {
  const numeric = typeof code === 'string' ? Number(code) : code;
  return (
    {
      0: '晴',
      1: '大部晴朗',
      2: '局部多云',
      3: '阴',
      45: '雾',
      48: '雾凇',
      51: '毛毛雨',
      53: '毛毛雨',
      55: '毛毛雨',
      61: '小雨',
      63: '中雨',
      65: '大雨',
      71: '小雪',
      73: '中雪',
      75: '大雪',
      80: '阵雨',
      81: '阵雨',
      82: '强阵雨',
      95: '雷雨',
      96: '雷雨伴冰雹',
      99: '雷雨伴冰雹',
    }[numeric as number] || '天气情况未知'
  );
}
