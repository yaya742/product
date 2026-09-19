import { useEffect, useMemo, useRef, useState } from 'react';
import { findWalkingRoute, loadMapData, type MapCoordinate, type MapData, type MapFeature, type MapPlace, type MapRoute } from './runtime/map';
import { readDeviceLocation, type DeviceLocation } from './runtime/weather';
import type { MobileLanguage } from './runtime/types';

interface MapPanelProps {
  language: MobileLanguage;
  onClose: () => void;
}

const WORLD_WIDTH = 1240;
const WORLD_HEIGHT = 1000;

function coordinate(value: unknown): MapCoordinate | undefined {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number'
    ? [value[0], value[1]]
    : undefined;
}

function pathForRing(ring: unknown): string {
  if (!Array.isArray(ring)) return '';
  return ring.map(coordinate).filter((point): point is MapCoordinate => !!point).map((point, index) => {
    const command = index === 0 ? 'M' : 'L';
    return `${command}${point[0]},${point[1]}`;
  }).join(' ') + ' Z';
}

function pathForGeometry(feature: MapFeature, project: (point: MapCoordinate) => [number, number]): string {
  const geometry = feature.geometry;
  const projectRing = (ring: unknown) => {
    if (!Array.isArray(ring)) return '';
    return ring.map(coordinate).filter((point): point is MapCoordinate => !!point).map((point, index) => {
      const [x, y] = project(point);
      return `${index === 0 ? 'M' : 'L'}${x},${y}`;
    }).join(' ') + (geometry.type.includes('Polygon') ? ' Z' : '');
  };
  if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') {
    return (geometry.coordinates as unknown[]).map(projectRing).filter(Boolean).join(' ');
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as unknown[]).flatMap((polygon) => Array.isArray(polygon) ? polygon.map(projectRing) : []).filter(Boolean).join(' ');
  }
  return projectRing(geometry.coordinates);
}

function distanceLabel(meters: number, language: MobileLanguage): string {
  const value = meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  if (language === 'en') return `Walking distance ${value}`;
  return language === 'zh-TW' ? `步行 ${value}` : `步行 ${value}`;
}

function placeMatches(data: MapData | undefined, query: string): MapPlace[] {
  if (!data || !query.trim()) return [];
  const needle = query.trim().toLowerCase();
  return data.places.filter((place) => [place.displayName, ...place.aliases].some((value) => value.toLowerCase().includes(needle))).slice(0, 7);
}

function PlaceInput({
  label,
  value,
  onChange,
  matches,
  onChoose,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  matches: MapPlace[];
  onChoose: (place: MapPlace) => void;
}) {
  return (
    <label className="map-search-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} autoComplete="off" />
      {!!matches.length && (
        <div className="map-search-results">
          {matches.map((place) => <button type="button" key={place.id} onClick={() => onChoose(place)}>{place.displayName}</button>)}
        </div>
      )}
    </label>
  );
}

export function MapPanel({ language, onClose }: MapPanelProps) {
  const [data, setData] = useState<MapData>();
  const [error, setError] = useState('');
  const [startQuery, setStartQuery] = useState('');
  const [endQuery, setEndQuery] = useState('');
  const [startPlace, setStartPlace] = useState<MapPlace>();
  const [endPlace, setEndPlace] = useState<MapPlace>();
  const [location, setLocation] = useState<DeviceLocation>();
  const [locating, setLocating] = useState(false);
  const [route, setRoute] = useState<MapRoute>();
  const [routeMessage, setRouteMessage] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | undefined>(undefined);
  const mapRef = useRef<SVGSVGElement>(null);
  const copy = language === 'en'
    ? {
      title: 'Campus map', hint: 'Offline campus map · search places and plan a walking route', loading: 'Loading local map…', loadError: 'The local map could not be loaded.', locate: 'Use my location', locating: 'Locating…', current: 'Current location', start: 'Start', destination: 'Destination', route: 'Plan route', reset: 'Reset view', noRoute: 'Choose a start and destination first.', routeUnavailable: 'No connected walking route was found.', attribution: '© OpenStreetMap contributors', limits: 'Open map data is not a real-time access or gate guarantee.', close: 'Close',
    }
    : language === 'zh-TW'
      ? {
        title: '校園地圖', hint: '離線校園地圖 · 搜尋地點並規劃步行路線', loading: '正在載入本機地圖…', loadError: '本機地圖載入失敗。', locate: '使用我的位置', locating: '正在定位…', current: '目前位置', start: '起點', destination: '終點', route: '規劃路線', reset: '重置視野', noRoute: '請先選擇起點和終點。', routeUnavailable: '沒有找到連通的步行路線。', attribution: '© OpenStreetMap contributors', limits: '開放地圖資料不代表即時門禁或通行保證。', close: '關閉',
      }
      : {
        title: '校园地图', hint: '离线校园地图 · 搜索地点并规划步行路线', loading: '正在加载本地地图…', loadError: '本地地图加载失败。', locate: '使用我的位置', locating: '正在定位…', current: '当前位置', start: '起点', destination: '终点', route: '规划路线', reset: '重置视野', noRoute: '请先选择起点和终点。', routeUnavailable: '没有找到连通的步行路线。', attribution: '© OpenStreetMap contributors', limits: '开放地图数据不代表实时门禁或通行保证。', close: '关闭',
      };

  useEffect(() => {
    const controller = new AbortController();
    void loadMapData(controller.signal).then(setData).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : copy.loadError);
    });
    return () => controller.abort();
  }, [copy.loadError]);

  const project = useMemo(() => {
    const bounds = data?.manifest.bounds || [120.06, 30.293, 120.101, 30.326];
    const width = bounds[2] - bounds[0];
    const height = bounds[3] - bounds[1];
    return (point: MapCoordinate): [number, number] => [
      ((point[0] - bounds[0]) / width) * WORLD_WIDTH,
      ((bounds[3] - point[1]) / height) * WORLD_HEIGHT,
    ];
  }, [data]);

  const featurePaths = useMemo(() => data?.features.map((feature, index) => ({
    id: `${feature.id || 'feature'}-${index}`,
    kind: feature.properties?.kind || 'area',
    d: pathForGeometry(feature, project),
  })).filter((feature) => feature.d) || [], [data, project]);

  const startCoordinate = location && !startPlace ? location.coordinate : startPlace?.coordinate;
  const endCoordinate = endPlace?.coordinate;
  const startMatches = placeMatches(data, startQuery);
  const endMatches = placeMatches(data, endQuery);

  async function locate() {
    setLocating(true);
    setRouteMessage('');
    try {
      const next = await readDeviceLocation();
      setLocation(next);
      setStartPlace(undefined);
      setStartQuery(copy.current);
    } catch (reason) {
      setRouteMessage(reason instanceof Error ? reason.message : copy.loadError);
    } finally {
      setLocating(false);
    }
  }

  function planRoute() {
    if (!startCoordinate || !endCoordinate) {
      setRoute(undefined);
      setRouteMessage(copy.noRoute);
      return;
    }
    const next = data && findWalkingRoute(data, startCoordinate, endCoordinate);
    setRoute(next);
    setRouteMessage(next ? distanceLabel(next.meters, language) : copy.routeUnavailable);
  }

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    mapRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!dragRef.current || !mapRef.current) return;
    const rect = mapRef.current.getBoundingClientRect();
    setPan({
      x: dragRef.current.panX + (event.clientX - dragRef.current.x) * WORLD_WIDTH / rect.width,
      y: dragRef.current.panY + (event.clientY - dragRef.current.y) * WORLD_HEIGHT / rect.height,
    });
  }

  function onPointerUp() {
    dragRef.current = undefined;
  }

  const transform = `translate(${pan.x} ${pan.y}) translate(${WORLD_WIDTH / 2} ${WORLD_HEIGHT / 2}) scale(${zoom}) translate(${-WORLD_WIDTH / 2} ${-WORLD_HEIGHT / 2})`;
  const routePath = route ? route.coordinates.map((point, index) => {
    const [x, y] = project(point);
    return `${index === 0 ? 'M' : 'L'}${x},${y}`;
  }).join(' ') : '';

  return (
    <section className="full-screen-panel map-panel" aria-label={copy.title}>
      <header className="secondary-topbar">
        <button className="back-button" onClick={onClose}><span>←</span><span>{copy.close}</span></button>
        <h2>{copy.title}</h2>
        <span className="topbar-spacer" />
      </header>
      <div className="map-screen">
        <div className="map-toolbar">
          <p>{copy.hint}</p>
          <button className="secondary-button" disabled={locating} onClick={() => void locate()}>{locating ? copy.locating : copy.locate}</button>
        </div>
        <div className="map-route-form">
          <PlaceInput label={copy.start} value={startQuery} onChange={(value) => { setStartQuery(value); setStartPlace(undefined); setLocation(undefined); }} matches={startMatches} onChoose={(place) => { setStartPlace(place); setLocation(undefined); setStartQuery(place.displayName); }} />
          <PlaceInput label={copy.destination} value={endQuery} onChange={(value) => { setEndQuery(value); setEndPlace(undefined); }} matches={endMatches} onChoose={(place) => { setEndPlace(place); setEndQuery(place.displayName); }} />
          <button className="primary-button map-route-button" onClick={planRoute}>{copy.route}</button>
        </div>
        <div className="map-canvas-wrap">
          {!data && !error && <div className="map-state-message">{copy.loading}</div>}
          {error && <div className="map-state-message map-error">{copy.loadError}<small>{error}</small></div>}
          {data && (
            <svg ref={mapRef} className="campus-map-svg" viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`} role="img" aria-label={copy.title} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
              <rect width={WORLD_WIDTH} height={WORLD_HEIGHT} className="map-background" />
              <g transform={transform}>
                {featurePaths.map((feature) => <path key={feature.id} d={feature.d} className={`map-feature map-feature-${feature.kind}`} />)}
                {routePath && <path d={routePath} className="map-route-path" />}
                {startCoordinate && <circle cx={project(startCoordinate)[0]} cy={project(startCoordinate)[1]} r="10" className="map-marker map-marker-start" />}
                {endCoordinate && <circle cx={project(endCoordinate)[0]} cy={project(endCoordinate)[1]} r="10" className="map-marker map-marker-end" />}
                {location && <circle cx={project(location.coordinate)[0]} cy={project(location.coordinate)[1]} r="5" className="map-location-dot" />}
              </g>
            </svg>
          )}
          <div className="map-zoom-controls">
            <button aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(4, value + .25))}>+</button>
            <button aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(1, value - .25))}>−</button>
            <button aria-label={copy.reset} onClick={resetView}>⌂</button>
          </div>
        </div>
        {routeMessage && <p className="map-route-message">{routeMessage}</p>}
        <p className="map-attribution">{data?.manifest.attribution || copy.attribution} · {copy.limits}</p>
      </div>
    </section>
  );
}
