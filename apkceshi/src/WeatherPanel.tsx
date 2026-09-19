import { useEffect, useState } from 'react';
import { CAMPUS_COORDINATE, fetchWeather, formatWeatherDay, rainIntervals, readDeviceLocation, searchWeatherLocations, weatherCodeText, type DeviceLocation, type WeatherLocation, type WeatherSnapshot } from './runtime/weather';
import type { MobileLanguage } from './runtime/types';

interface WeatherPanelProps {
  language: MobileLanguage;
  onClose: () => void;
}

const CAMPUS_LOCATION: WeatherLocation = {
  name: '紫金港校区',
  displayName: '紫金港校区',
  coordinate: CAMPUS_COORDINATE,
};

function weatherIcon(code: number): string {
  if (code >= 95) return '⛈️';
  if (code >= 71 && code <= 86) return '🌨️';
  if (code >= 51) return '🌧️';
  if (code >= 1) return '⛅';
  return '☀️';
}

function formatWeatherHour(value: string, language: MobileLanguage): string {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : language, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function WeatherPanel({ language, onClose }: WeatherPanelProps) {
  const [weather, setWeather] = useState<WeatherSnapshot>();
  const [selectedLocation, setSelectedLocation] = useState<WeatherLocation>(CAMPUS_LOCATION);
  const [deviceLocation, setDeviceLocation] = useState<DeviceLocation>();
  const [placeQuery, setPlaceQuery] = useState('');
  const [placeResults, setPlaceResults] = useState<WeatherLocation[]>([]);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const copy = language === 'en'
    ? {
      title: 'Weather', place: 'Location', placePlaceholder: 'Search a city or place', search: 'Search', campus: 'Zijingang campus', useLocation: 'Use my location', refresh: 'Refresh', loading: 'Loading…', failed: 'Weather could not be loaded.', feelsLike: 'Feels like', humidity: 'Humidity', wind: 'Wind', next24: 'Rain in the next 24 hours', noRain: 'No obvious rain in the next 24 hours', hourly: 'Next 24 hours', forecast: '5-day forecast', current: 'Current', close: 'Close', updated: 'Updated',
    }
    : language === 'zh-TW'
      ? {
        title: '天氣', place: '地點', placePlaceholder: '搜尋城市或地點', search: '搜尋', campus: '紫金港校區', useLocation: '使用我的位置', refresh: '重新整理', loading: '正在載入…', failed: '天氣載入失敗。', feelsLike: '體感', humidity: '濕度', wind: '風速', next24: '未來 24 小時降雨', noRain: '未來 24 小時沒有明顯降雨', hourly: '未來 24 小時', forecast: '未來 5 天', current: '目前', close: '關閉', updated: '更新於',
      }
      : {
        title: '天气', place: '地点', placePlaceholder: '搜索城市或地点', search: '搜索', campus: '紫金港校区', useLocation: '使用我的位置', refresh: '刷新', loading: '正在加载…', failed: '天气加载失败。', feelsLike: '体感', humidity: '湿度', wind: '风速', next24: '未来 24 小时降雨', noRain: '未来 24 小时没有明显降雨', hourly: '未来 24 小时', forecast: '未来 5 天', current: '当前', close: '关闭', updated: '更新于',
      };

  async function refresh(location: WeatherLocation = selectedLocation) {
    setLoading(true);
    setMessage('');
    try {
      setWeather(await fetchWeather(location.coordinate));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : copy.failed);
    } finally {
      setLoading(false);
    }
  }

  async function useCurrentLocation() {
    setLoading(true);
    setMessage('');
    try {
      const current = await readDeviceLocation();
      setDeviceLocation(current);
      const location: WeatherLocation = { name: '当前位置', displayName: '当前位置', coordinate: current.coordinate };
      setSelectedLocation(location);
      setPlaceQuery('');
      setPlaceResults([]);
      setWeather(await fetchWeather(current.coordinate));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : copy.failed);
    } finally {
      setLoading(false);
    }
  }

  async function searchPlace() {
    const query = placeQuery.trim();
    if (!query) return;
    setSearching(true);
    setMessage('');
    try {
      setPlaceResults(await searchWeatherLocations(query));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : copy.failed);
    } finally {
      setSearching(false);
    }
  }

  function choosePlace(place: WeatherLocation) {
    setSelectedLocation(place);
    setDeviceLocation(undefined);
    setPlaceQuery(place.displayName);
    setPlaceResults([]);
    void refresh(place);
  }

  useEffect(() => {
    void refresh(CAMPUS_LOCATION);
    // The panel loads its initial location once; language changes only affect labels and formatting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = weather?.current;
  const rain = weather ? rainIntervals(weather, language) : [];
  return (
    <section className="full-screen-panel weather-panel" aria-label={copy.title}>
      <header className="secondary-topbar">
        <button className="back-button" onClick={onClose}><span>←</span><span>{copy.close}</span></button>
        <h2>{copy.title}</h2>
        <span className="topbar-spacer" />
      </header>
      <div className="weather-screen">
        <div className="weather-location-bar">
          <label className="weather-place-field"><span>{copy.place}</span><input value={placeQuery} placeholder={placeQuery ? '' : copy.placePlaceholder} onChange={(event) => { setPlaceQuery(event.target.value); setPlaceResults([]); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void searchPlace(); } }} /></label>
          <button className="secondary-button" disabled={searching || loading} onClick={() => void searchPlace()}>{searching ? '…' : copy.search}</button>
        </div>
        {!!placeResults.length && <div className="weather-place-results">{placeResults.map((place) => <button key={`${place.displayName}-${place.coordinate.join(',')}`} onClick={() => choosePlace(place)}>{place.displayName}</button>)}</div>}
        <div className="weather-toolbar">
          <div><p className="eyebrow">{selectedLocation.displayName}</p><h1>{copy.title}</h1></div>
          <div className="weather-toolbar-actions">
            <button className="secondary-button" disabled={loading} onClick={() => void useCurrentLocation()}>{copy.useLocation}</button>
            <button className="icon-refresh-button" disabled={loading} onClick={() => void refresh()} aria-label={copy.refresh}>↻</button>
          </div>
        </div>
        {loading && <div className="weather-state-message">{copy.loading}</div>}
        {!loading && message && <div className="weather-state-message weather-error">{copy.failed}<small>{message}</small></div>}
        {!loading && current && weather && (
          <>
            <section className="weather-current-card">
              <div className="weather-current-main"><span className="weather-symbol">{weatherIcon(current.weatherCode)}</span><div><strong>{Math.round(current.temperature)}°</strong><p>{weatherCodeText(current.weatherCode, language)}</p></div></div>
              <div className="weather-metrics"><span>{copy.feelsLike}<strong>{Math.round(current.apparentTemperature)}°</strong></span><span>{copy.humidity}<strong>{Math.round(current.humidity)}%</strong></span><span>{copy.wind}<strong>{Math.round(current.windSpeed)} km/h</strong></span></div>
            </section>
            <section className="weather-rain-card"><h2>{copy.next24}</h2>{rain.length ? <div className="weather-rain-intervals">{rain.map((item) => <span key={item}>{item}</span>)}</div> : <p>{copy.noRain}</p>}</section>
            <section className="weather-forecast-card"><h2>{copy.hourly}</h2><div className="weather-hourly-list">{weather.hourly.map((hour) => <div className="weather-hour" key={hour.time}><span>{formatWeatherHour(hour.time, language)}</span><span>{weatherIcon(hour.weatherCode)} {Math.round(hour.temperature)}°</span><strong>{hour.precipitationProbability}%</strong></div>)}</div></section>
            <section className="weather-forecast-card"><h2>{copy.forecast}</h2><div className="weather-forecast-list">{weather.daily.map((day) => <div className="weather-day" key={day.date}><span>{formatWeatherDay(day.date, language)}</span><strong>{weatherCodeText(day.weatherCode, language)}</strong><span>{Math.round(day.min)}° / {Math.round(day.max)}°</span><small>{day.precipitationProbability}%</small></div>)}</div></section>
            <p className="weather-source">{copy.updated} {formatWeatherHour(current.time, language)}</p>
          </>
        )}
      </div>
    </section>
  );
}
