import { useEffect, useState } from 'react';
import { CAMPUS_COORDINATE, fetchWeather, formatWeatherDay, readDeviceLocation, weatherCodeText, type DeviceLocation, type WeatherSnapshot } from './runtime/weather';
import type { MobileLanguage } from './runtime/types';

interface WeatherPanelProps {
  language: MobileLanguage;
  onClose: () => void;
}

export function WeatherPanel({ language, onClose }: WeatherPanelProps) {
  const [weather, setWeather] = useState<WeatherSnapshot>();
  const [location, setLocation] = useState<DeviceLocation>();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const copy = language === 'en'
    ? {
      title: 'Weather', hint: 'Direct forecast · no server deployment required', campus: 'Zijingang campus', useLocation: 'Use my location', refresh: 'Refresh', loading: 'Loading weather…', failed: 'Weather could not be loaded.', feelsLike: 'Feels like', humidity: 'Humidity', wind: 'Wind', forecast: '5-day forecast', source: 'Open-Meteo forecast · location is approximate', close: 'Close',
    }
    : language === 'zh-TW'
      ? {
        title: '天氣', hint: '手機直連預報 · 不需要部署伺服器', campus: '紫金港校區', useLocation: '使用我的位置', refresh: '重新整理', loading: '正在載入天氣…', failed: '天氣載入失敗。', feelsLike: '體感', humidity: '濕度', wind: '風速', forecast: '未來 5 天', source: 'Open-Meteo 預報 · 位置為近似值', close: '關閉',
      }
      : {
        title: '天气', hint: '手机直连预报 · 不需要部署服务器', campus: '紫金港校区', useLocation: '使用我的位置', refresh: '刷新', loading: '正在加载天气…', failed: '天气加载失败。', feelsLike: '体感', humidity: '湿度', wind: '风速', forecast: '未来 5 天', source: 'Open-Meteo 预报 · 位置为近似值', close: '关闭',
      };

  async function refresh(useDeviceLocation: boolean) {
    setLoading(true);
    setMessage('');
    try {
      let nextLocation = location;
      if (useDeviceLocation) {
        nextLocation = await readDeviceLocation();
        setLocation(nextLocation);
      }
      setWeather(await fetchWeather(nextLocation?.coordinate || CAMPUS_COORDINATE));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : copy.failed);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh(false);
    // The panel is mounted for one language snapshot; language changes are reflected in formatting below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = weather?.current;
  return (
    <section className="full-screen-panel weather-panel" aria-label={copy.title}>
      <header className="secondary-topbar">
        <button className="back-button" onClick={onClose}><span>←</span><span>{copy.close}</span></button>
        <h2>{copy.title}</h2>
        <span className="topbar-spacer" />
      </header>
      <div className="weather-screen">
        <div className="weather-toolbar">
          <div><p className="eyebrow">{location ? copy.useLocation : copy.campus}</p><h1>{copy.title}</h1><p>{copy.hint}</p></div>
          <div className="weather-toolbar-actions">
            <button className="secondary-button" disabled={loading} onClick={() => void refresh(true)}>{copy.useLocation}</button>
            <button className="icon-refresh-button" disabled={loading} onClick={() => void refresh(!!location)} aria-label={copy.refresh}>↻</button>
          </div>
        </div>
        {loading && <div className="weather-state-message">{copy.loading}</div>}
        {!loading && message && <div className="weather-state-message weather-error">{copy.failed}<small>{message}</small></div>}
        {!loading && current && weather && (
          <>
            <section className="weather-current-card">
              <div className="weather-current-main"><span className="weather-symbol">{current.weatherCode >= 50 ? '☔' : current.weatherCode >= 1 ? '⛅' : '☀️'}</span><div><strong>{Math.round(current.temperature)}°</strong><p>{weatherCodeText(current.weatherCode, language)}</p></div></div>
              <div className="weather-metrics"><span>{copy.feelsLike}<strong>{Math.round(current.apparentTemperature)}°</strong></span><span>{copy.humidity}<strong>{Math.round(current.humidity)}%</strong></span><span>{copy.wind}<strong>{Math.round(current.windSpeed)} km/h</strong></span></div>
            </section>
            <section className="weather-forecast-card"><h2>{copy.forecast}</h2><div className="weather-forecast-list">
              {weather.daily.map((day) => <div className="weather-day" key={day.date}><span>{formatWeatherDay(day.date, language)}</span><strong>{weatherCodeText(day.weatherCode, language)}</strong><span>{Math.round(day.min)}° / {Math.round(day.max)}°</span><small>{day.precipitationProbability}%</small></div>)}
            </div></section>
            <p className="weather-source">{copy.source} · {weather.timezone}</p>
          </>
        )}
      </div>
    </section>
  );
}
