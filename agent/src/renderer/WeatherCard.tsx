import { CloudSun, Droplets, Umbrella, Wind } from 'lucide-react';
import type { WeatherCard as WeatherCardData } from '../shared/weather-v1';
import { weatherConditionText } from '../shared/weather-v1';
import './weather.css';

function numberLabel(value: number | undefined, suffix: string, digits = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(digits)}${suffix}`
    : '—';
}

function dayLabel(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

export function WeatherCard({ card }: { card: WeatherCardData }) {
  const current = card.current;
  const forecast = card.forecast;
  const days = forecast.time.slice(0, 5).map((date, index) => ({
    date,
    high: forecast.temperature_2m_max?.[index],
    low: forecast.temperature_2m_min?.[index],
    rain: forecast.precipitation_probability_max?.[index],
    code: forecast.weather_code?.[index],
  }));
  const sourceLabel = card.source.startsWith('plugin:') ? '天气插件' : card.source;
  return (
    <section className="weather-card" aria-label="天气信息">
      <div className="weather-card-header">
        <div className="weather-card-title">
          <span className="weather-card-eyebrow"><CloudSun size={15} /> 天气</span>
          <strong>{card.location}</strong>
          <small>来源：{sourceLabel} · {new Date(card.fetchedAt).toLocaleTimeString('zh-CN')}</small>
        </div>
        <div className="weather-card-now">
          <strong>{numberLabel(current.temperature_2m, '°')}</strong>
          <span>{weatherConditionText(current.weather_code)}</span>
        </div>
      </div>
      <div className="weather-card-metrics">
        <span><Wind size={14} />体感 {numberLabel(current.apparent_temperature, '°C')}</span>
        <span><Droplets size={14} />湿度 {numberLabel(current.relative_humidity_2m, '%')}</span>
        <span><Umbrella size={14} />降水 {numberLabel(current.precipitation, ' mm', 1)}</span>
      </div>
      {days.length > 0 && (
        <div className="weather-card-forecast">
          {days.map((day) => (
            <div className="weather-day" key={day.date}>
              <small>{dayLabel(day.date)}</small>
              <span>{weatherConditionText(day.code)}</span>
              <strong>{numberLabel(day.high, '°')} <em>{numberLabel(day.low, '°')}</em></strong>
              <small className="weather-rain">降水 {numberLabel(day.rain, '%')}</small>
            </div>
          ))}
        </div>
      )}
      {card.warnings.length > 0 && (
        <p className="weather-card-warning">{card.warnings.join(' ')}</p>
      )}
    </section>
  );
}
