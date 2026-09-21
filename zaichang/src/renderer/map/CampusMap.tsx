import { useEffect, useReducer, useRef, useState, type RefObject } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Compass,
  LocateFixed,
  MapPinned,
  Maximize,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  Route,
  Search,
  X,
  Info,
} from 'lucide-react';
import {
  emptyRoute,
  type MapCard,
  type MapPoint,
  type MapRouteResult,
  type LocationStatusResult,
  type LocationFix,
  type MapOverview,
} from '../../shared/map-v2';
import { classifyFix, inBounds } from '../../shared/map-routing';
import { initialSelection, selectionReducer, type SelectionState } from './map-state';
import type { MapData, PlanarCampusMap, SavedCamera } from './map-engine';
import './map.css';

const api = window.zaichang;
let dataCache: MapData | undefined;
let savedCamera: SavedCamera | undefined;
let savedSelection: SelectionState | undefined;
let entered = false;
let sessionLocationEnabled = true;
async function loadData(signal: AbortSignal): Promise<MapData> {
  if (dataCache) return dataCache;
  const load = async (name: string) => {
    const r = await fetch(new URL(`map-v2/${name}`, document.baseURI), { signal });
    if (!r.ok) throw new Error(`地图文件未能载入（${r.status}）。`);
    return r.json();
  };
  const [manifest, places, geography] = await Promise.all([
    api.mapOverview(),
    load('places.json'),
    load('geography.geojson'),
  ]);
  if (
    manifest.schemaVersion !== 'campus-map/v2' ||
    !Array.isArray(places) ||
    geography.type !== 'FeatureCollection'
  )
    throw new Error('地图数据格式无效，请重新构建数据。');
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  return (dataCache = { manifest, places, geography });
}
function initialState(route: MapRouteResult): SelectionState {
  if (route.schemaVersion === 'map-route/v2' && route.to)
    return {
      ...initialSelection,
      mode: route.from ? 'two' : 'current',
      origin: route.from,
      destination: route.to,
      route: emptyRoute(),
    };
  if (savedSelection) return { ...savedSelection, route: emptyRoute() };
  return { ...initialSelection };
}
function distanceLabel(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} 公里` : `${Math.round(m)} 米`;
}
export function MapRouteCard({ card, onOpen }: { card: MapCard; onOpen: () => void }) {
  const current = card.route?.schemaVersion === 'map-route/v2',
    r = card.route;
  return (
    <button className="campus-v2-card" onClick={onOpen} aria-label="在校园地图中打开">
      <span className="campus-v2-card-icon">
        <MapPinned size={23} />
      </span>
      <span>
        <strong>{current && r.to ? r.to.displayName : '打开校园地图'}</strong>
        <small>
          {current && r.status === 'ready' && r.distance
            ? `步行 ${distanceLabel(r.distance.totalM)} · 入口到入口`
            : current
              ? r.reason
              : '地图已更新，请在新地图中重新选择地点。'}
        </small>
      </span>
      <ArrowUpRight size={18} />
    </button>
  );
}
export function MapSheet({ initialRoute, onClose }: { initialRoute: MapRouteResult; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    stage = useRef<HTMLDivElement>(null),
    engine = useRef<PlanarCampusMap | undefined>(undefined);
  const compass = useRef<HTMLSpanElement>(null),
    scale = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null),
    coverage = useRef<HTMLSpanElement>(null);
  const [data, setData] = useState<MapData>(),
    [loadError, setLoadError] = useState(''),
    [attempt, setAttempt] = useState(0),
    [engineReady, setEngineReady] = useState(false);
  const [selection, dispatch] = useReducer(selectionReducer, initialRoute, initialState),
    selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [query, setQuery] = useState(''),
    [searchOpen, setSearchOpen] = useState(false),
    [onlyConnected, setOnlyConnected] = useState(false),
    [resultIndex, setResultIndex] = useState(0);
  const [hover, setHover] = useState<MapPoint>(),
    [candidates, setCandidates] = useState<MapPoint[]>([]),
    [about, setAbout] = useState(false),
    [help, setHelp] = useState(false);
  const [location, setLocation] = useState<LocationStatusResult>({
    status: 'idle',
    reason: sessionLocationEnabled ? '本机定位尚未开启。' : '本次会话已停止本机定位；点击定位可以重新开启。',
    source: 'windows-native',
    phoneConnected: false,
  });
  const locationRef = useRef(location);
  locationRef.current = location;
  const tracking = useRef(sessionLocationEnabled);
  const alive = useRef(true),
    locationRevision = useRef(0),
    touched = useRef(false),
    first = useRef(!entered),
    introDone = useRef(false);
  const initialDestination = useRef(
    initialRoute.schemaVersion === 'map-route/v2' ? initialRoute.to?.id : undefined,
  );
  const activity = useRef(0),
    pendingLocate = useRef<{ fix: LocationFix; activity: number } | undefined>(undefined);
  const feedback = useRef({ rotation: NaN, width: NaN, label: '' });
  const requestRef = useRef<(explicit?: boolean) => Promise<void>>(async () => {});
  const results = (data?.places || [])
    .filter((p) => !onlyConnected || p.entrances.some((e) => e.connected))
    .filter((p) =>
      [p.displayName, ...p.aliases, p.id].some((n) => n.toLowerCase().includes(query.trim().toLowerCase())),
    )
    .sort(
      (a, b) =>
        Number(b.displayName === query) - Number(a.displayName === query) ||
        a.displayName.localeCompare(b.displayName, 'zh-CN'),
    );
  const shown = results.slice(0, 40);
  function user() {
    activity.current++;
    touched.current = true;
    introDone.current = true;
    setHover(undefined);
  }
  function choose(point: MapPoint) {
    user();
    engine.current?.takeControl();
    dispatch({ type: 'choose', point });
    setSearchOpen(false);
    setQuery('');
    setCandidates([]);
    stage.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    alive.current = true;
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    entered = true;
    return () => {
      alive.current = false;
      locationRevision.current++;
      void api.mapStopLocation();
      savedSelection = { ...selectionRef.current, route: emptyRoute() };
      dialog.current?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError('');
    loadData(controller.signal)
      .then((d) => {
        if (!controller.signal.aborted) setData(d);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setLoadError(String(e.message || e));
      });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    if (!data || !stage.current) return;
    let disposed = false;
    import('./map-engine')
      .then(({ PlanarCampusMap }) => {
        if (disposed || !stage.current) return;
        const map = new PlanarCampusMap(
          stage.current,
          data,
          {
            choose,
            candidates: setCandidates,
            hover: setHover,
            blank: () => {
              setHover(undefined);
              setCandidates([]);
              setSearchOpen(false);
            },
            user,
            camera: (c) => {
              savedCamera = c;
              if (c.rotation !== feedback.current.rotation) {
                const needle = compass.current?.querySelector('i');
                if (needle) needle.style.transform = `rotate(${c.rotation}rad)`;
                feedback.current.rotation = c.rotation;
              }
              const lat = (Math.atan(Math.exp(c.center[1] / 6378137)) * 360) / Math.PI - 90;
              if (coverage.current) {
                const covered = inBounds(
                  [(c.center[0] * 180) / Math.PI / 6378137, lat],
                  data.manifest.bounds,
                );
                if (coverage.current.hidden !== covered) coverage.current.hidden = covered;
              }
              if (scale.current) {
                const ground = c.resolution * Math.cos((lat * Math.PI) / 180),
                  ideal = ground * 90,
                  power = 10 ** Math.floor(Math.log10(ideal)),
                  m =
                    [1, 2, 5, 10]
                      .map((v) => v * power)
                      .filter((v) => v <= ideal)
                      .at(-1) || power;
                const width = Math.round((m / ground) * 10) / 10,
                  label = m >= 1000 ? `${m / 1000} km` : `${m} m`;
                if (width !== feedback.current.width) {
                  scale.current.style.width = `${width}px`;
                  feedback.current.width = width;
                }
                if (label !== feedback.current.label) {
                  scale.current.textContent = label;
                  feedback.current.label = label;
                }
              }
            },
            ready: () => {
              if (alive.current) setEngineReady(true);
            },
          },
          savedCamera,
        );
        engine.current = map;
        if (touched.current) map.takeControl();
      })
      .catch((e) => setLoadError(String(e.message || e)));
    return () => {
      disposed = true;
      setEngineReady(false);
      engine.current?.dispose();
      engine.current = undefined;
    };
  }, [data]);
  useEffect(() => {
    if (engineReady) engine.current?.select(selection.destination, selection.origin);
  }, [engineReady, selection.destination, selection.origin]);
  useEffect(() => {
    if (engineReady && initialDestination.current && !touched.current) {
      const point = data?.places.find((p) => p.id === initialDestination.current);
      initialDestination.current = undefined;
      if (point) {
        introDone.current = true;
        engine.current?.focusPlace(point);
      }
    }
  }, [engineReady]);
  useEffect(() => {
    if (engineReady) engine.current?.route(selection.route);
  }, [engineReady, selection.route]);
  useEffect(() => {
    if (!data || !engineReady || !selection.destination || selection.stage === 'origin') return;
    let current = true,
      fitFrame = 0;
    const revision = selection.revision,
      ticket = engine.current!.ownership.ticket();
    dispatch({ type: 'loading', revision });
    const from =
      selection.mode === 'two' && selection.origin
        ? { kind: 'place' as const, id: selection.origin.id }
        : selection.mode === 'current' && locationRef.current.status === 'fresh'
          ? { kind: 'current' as const }
          : undefined;
    api
      .mapRoute({ from, to: { kind: 'place', id: selection.destination.id }, version: data.manifest.version })
      .then((route) => {
        if (!current || !alive.current) return;
        dispatch({ type: 'result', revision, route });
        if (route.status === 'ready')
          fitFrame = requestAnimationFrame(() => {
            if (current && selectionRef.current.revision === revision)
              engine.current?.fitRoute(route, ticket);
          });
      })
      .catch((e) => {
        if (current && alive.current)
          dispatch({
            type: 'result',
            revision,
            route: { ...emptyRoute(), status: 'error', reason: String(e.message || e) },
          });
      });
    return () => {
      current = false;
      cancelAnimationFrame(fitFrame);
    };
  }, [selection.revision, data, engineReady]);
  requestRef.current = async (explicit = false) => {
    if (document.visibilityState === 'hidden') return;
    if (explicit) tracking.current = sessionLocationEnabled = true;
    if (!tracking.current) return;
    if (explicit) {
      engine.current?.takeControl();
      user();
    }
    const revision = ++locationRevision.current,
      ticket = engine.current?.ownership.ticket(),
      activityTicket = activity.current;
    setLocation((s) => ({ ...s, status: 'requesting', reason: '正在获取这台电脑的位置…' }));
    let result: LocationStatusResult;
    try {
      result = await api.mapLocate();
    } catch {
      result = {
        status: 'unavailable',
        source: 'windows-native',
        phoneConnected: false,
        reason: '本机定位暂不可用；可以手动选择起点。',
      };
    }
    if (!alive.current || revision !== locationRevision.current) return;
    if (result.fix && data)
      result = {
        ...result,
        status: classifyFix(result.fix, data.manifest.bounds, Date.now(), locationRef.current.fix),
      };
    setLocation(result);
    if (result.fix && result.status === 'fresh' && engine.current) {
      if (explicit && activityTicket === activity.current) engine.current.locate(result.fix, false, ticket);
      else if (first.current && !introDone.current && !touched.current) {
        introDone.current = true;
        engine.current.locate(result.fix, true, ticket);
      }
    }
    if (
      explicit &&
      result.fix &&
      result.status === 'fresh' &&
      !engine.current &&
      activityTicket === activity.current
    )
      pendingLocate.current = { fix: result.fix, activity: activityTicket };
  };
  function stopLocation() {
    tracking.current = sessionLocationEnabled = false;
    locationRevision.current++;
    pendingLocate.current = undefined;
    engine.current?.takeControl();
    user();
    void api.mapStopLocation();
    setLocation({
      status: 'idle',
      source: 'windows-native',
      phoneConnected: false,
      reason: '本次会话已停止本机定位；点击定位可以重新开启。',
    });
    if (selectionRef.current.mode === 'current') dispatch({ type: 'retry' });
  }
  useEffect(() => {
    void requestRef.current();
    const timer = setInterval(() => {
      if (['fresh', 'approximate', 'outside'].includes(locationRef.current.status)) void requestRef.current();
    }, 30000);
    const visible = () => {
      if (document.visibilityState === 'hidden') {
        locationRevision.current++;
        void api.mapStopLocation();
      } else if (locationRef.current.fix) void requestRef.current();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      locationRevision.current++;
      void api.mapStopLocation();
    };
  }, []);
  useEffect(() => {
    if (!engineReady) return;
    const usable =
      location.fix && data
        ? ['fresh', 'approximate'].includes(classifyFix(location.fix, data.manifest.bounds))
        : false;
    engine.current?.location(usable ? location.fix : undefined);
    const pending = pendingLocate.current;
    if (pending) {
      pendingLocate.current = undefined;
      if (pending.activity === activity.current) engine.current?.locate(pending.fix);
    }
    if (
      location.status === 'fresh' &&
      location.fix &&
      first.current &&
      !introDone.current &&
      !touched.current
    ) {
      introDone.current = true;
      engine.current?.locate(location.fix, true);
    }
  }, [engineReady, location]);
  useEffect(() => {
    setResultIndex(0);
  }, [query, onlyConnected]);
  useEffect(() => {
    if (searchOpen)
      document.getElementById(`campus-result-${resultIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [resultIndex]);
  function cancel(e: React.SyntheticEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (searchOpen) {
      setSearchOpen(false);
      search.current?.focus();
    } else if (about || help || candidates.length) {
      setAbout(false);
      setHelp(false);
      setCandidates([]);
      stage.current?.focus();
    } else if (selection.mode === 'two' && selection.stage !== 'browse') {
      dispatch({ type: 'current' });
      stage.current?.focus();
    } else onClose();
  }
  const route = selection.route,
    p = selection.destination;
  const hoverPixel =
    hover && engine.current
      ? engine.current.map.getPixelFromCoordinate(fromWgs84(hover.coordinate))
      : undefined;
  return (
    <dialog
      ref={dialog}
      className="campus-v2-dialog"
      aria-label="校园地图"
      onCancel={cancel}
      onKeyDownCapture={() => {
        activity.current++;
        touched.current = true;
      }}
    >
      <header className="campus-v2-header">
        <button
          type="button"
          className="campus-v2-return"
          aria-label="返回对话"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }}
        >
          <ArrowLeft size={18} />
          <span>返回</span>
        </button>
        <div>
          <strong>校园地图</strong>
          <span>紫金港 · 望月公寓</span>
        </div>
        <button
          className="campus-v2-icon"
          aria-label="地图来源与覆盖范围"
          onClick={() => {
            setAbout(!about);
            setHelp(false);
          }}
        >
          <Info size={18} />
        </button>
      </header>
      <div
        className="campus-v2-body"
        onPointerDown={() => {
          activity.current++;
          touched.current = true;
        }}
      >
        <div
          ref={stage}
          className="campus-v2-stage"
          role="application"
          tabIndex={0}
          aria-label="校园平面地图。方向键平移，加减缩放，Q E 旋转，N 回北，0 查看校园。"
        />
        <div className="campus-v2-top campus-v2-obstruction">
          <div className="campus-v2-search">
            <Search size={18} />
            <input
              ref={search}
              aria-label="搜索建筑或地点"
              role="combobox"
              aria-expanded={searchOpen}
              aria-controls="campus-search-results"
              aria-autocomplete="list"
              aria-activedescendant={
                searchOpen && shown[resultIndex] ? `campus-result-${resultIndex}` : undefined
              }
              placeholder="搜索建筑、地点"
              value={query}
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => {
                user();
                setQuery(e.target.value);
                setSearchOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSearchOpen(true);
                  setResultIndex((i) =>
                    Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))),
                  );
                }
                if (e.key === 'Enter' && shown[resultIndex]) {
                  e.preventDefault();
                  const point = shown[resultIndex];
                  choose(point);
                  engine.current?.focusPlace(point);
                }
                if (e.key === 'Escape' && searchOpen) {
                  e.preventDefault();
                  e.stopPropagation();
                  setSearchOpen(false);
                }
              }}
            />
            {query ? (
              <button aria-label="清空搜索" onClick={() => setQuery('')}>
                <X size={16} />
              </button>
            ) : (
              <span className="campus-v2-key">⌕</span>
            )}
          </div>
          {searchOpen && (
            <div className="campus-v2-results">
              <button
                className="campus-v2-filter"
                role="switch"
                aria-checked={onlyConnected}
                onClick={() => setOnlyConnected(!onlyConnected)}
              >
                <span>只看有路网入口的地点</span>
                {onlyConnected ? <Check size={15} /> : <span>全部</span>}
              </button>
              <div id="campus-search-results" role="listbox" aria-label="地点搜索结果">
                {shown.map((point, i) => (
                  <button
                    key={point.id}
                    id={`campus-result-${i}`}
                    data-place-id={point.id}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === resultIndex}
                    onClick={() => {
                      choose(point);
                      engine.current?.focusPlace(point);
                    }}
                  >
                    <span>{point.displayName}</span>
                    <small>
                      {point.kind === 'area'
                        ? '片区'
                        : point.entrances.some((e) => e.connected)
                          ? '建筑 · 入口已连接'
                          : '建筑 · 入口待核实'}
                    </small>
                  </button>
                ))}
              </div>
              <p>
                {results.length
                  ? `${results.length} 个匹配地点${results.length > 40 ? ' · 请继续输入以缩小范围' : ''}`
                  : '没有找到这个名称；不代表地点不存在。'}
              </p>
            </div>
          )}
          <div className="campus-v2-mode">
            <button
              className={selection.mode === 'two' ? 'active' : ''}
              onClick={() => {
                user();
                dispatch({ type: selection.mode === 'two' ? 'current' : 'two' });
                setSearchOpen(false);
              }}
            >
              <Route size={16} />
              {selection.mode === 'two' ? '退出两点路线' : '两点路线'}
            </button>
            <span aria-live="polite">
              {selection.stage === 'origin'
                ? '请选择起点 A'
                : selection.stage === 'destination'
                  ? '请选择终点 B'
                  : selection.mode === 'two'
                    ? '起点已固定 · 点选更换终点'
                    : ''}
            </span>
          </div>
        </div>
        <div className="campus-v2-controls campus-v2-obstruction">
          <div>
            <button aria-label="定位到本机" title="定位到本机" onClick={() => void requestRef.current(true)}>
              <LocateFixed size={20} />
            </button>
            <button aria-label="地图回北" title="回北 · N" onClick={() => engine.current?.north()}>
              <span ref={compass} className="campus-v2-north">
                N<i />
              </span>
            </button>
          </div>
          <div>
            <button aria-label="放大地图" title="放大 · +" onClick={() => engine.current?.zoom(0.6)}>
              <Plus size={19} />
            </button>
            <button aria-label="缩小地图" title="缩小 · −" onClick={() => engine.current?.zoom(-0.6)}>
              <Minus size={19} />
            </button>
          </div>
          <div>
            <button
              aria-label="逆时针旋转地图"
              title="逆时针旋转 · Q"
              onClick={() => engine.current?.rotate(-Math.PI / 12)}
            >
              <RotateCcw size={17} />
            </button>
            <button
              aria-label="顺时针旋转地图"
              title="顺时针旋转 · E"
              onClick={() => engine.current?.rotate(Math.PI / 12)}
            >
              <RotateCw size={17} />
            </button>
            <button aria-label="查看校园全貌" title="查看校园 · 0" onClick={() => engine.current?.overview()}>
              <Maximize size={17} />
            </button>
          </div>
        </div>
        {hover && hoverPixel && !searchOpen && (
          <div
            className="campus-v2-tooltip"
            style={{
              left: Math.max(20, Math.min((stage.current?.clientWidth || 800) - 210, hoverPixel[0] + 12)),
              top: Math.max(90, Math.min((stage.current?.clientHeight || 600) - 65, hoverPixel[1] - 32)),
            }}
          >
            {hover.displayName}
          </div>
        )}
        {candidates.length > 0 && (
          <div className="campus-v2-candidates campus-v2-floating" aria-label="请选择附近建筑">
            <strong>你想选择哪一栋？</strong>
            {candidates.map((p) => (
              <button key={p.id} onClick={() => choose(p)}>
                {p.displayName}
              </button>
            ))}
            <button onClick={() => setCandidates([])}>取消</button>
          </div>
        )}
        {loadError ? (
          <div className="campus-v2-empty" role="alert">
            <MapPinned size={28} />
            <strong>地图暂未载入</strong>
            <p>{loadError}</p>
            <button
              onClick={() => {
                dataCache = undefined;
                setAttempt((a) => a + 1);
              }}
            >
              重新载入
            </button>
          </div>
        ) : (
          !engineReady && (
            <div className="campus-v2-loading" role="status">
              正在展开校园地图…
            </div>
          )
        )}
        {(p || selection.origin || selection.mode === 'two') && (
          <section
            className="campus-v2-route campus-v2-obstruction"
            aria-label="路线信息"
            data-status={route.status}
          >
            <div className="campus-v2-endpoints">
              <button
                onClick={() => {
                  user();
                  dispatch({ type: 'origin' });
                }}
              >
                <span className="campus-v2-endpoint">A</span>
                <span>
                  {selection.mode === 'current' ? '本机位置' : selection.origin?.displayName || '选择起点'}
                </span>
              </button>
              <ArrowLeftRight size={15} />
              <button
                onClick={() => {
                  user();
                  dispatch({ type: 'destination' });
                }}
              >
                <span className="campus-v2-endpoint filled">B</span>
                <span>{p?.displayName || '选择终点'}</span>
              </button>
            </div>
            <div className="campus-v2-route-main" aria-live="polite">
              <div>
                <strong>
                  {route.status === 'ready' && route.distance
                    ? `步行 ${distanceLabel(route.distance.totalM)}`
                    : route.status === 'loading'
                      ? '正在计算路线'
                      : p
                        ? p.displayName
                        : '轻点地图上的建筑'}
                </strong>
                <p>
                  {selection.stage === 'origin'
                    ? '请选择你实际所在的起点建筑。'
                    : route.status === 'ready'
                      ? `${route.originEntrance?.name} → ${route.destinationEntrance?.name} · 路网内最短 · 通行以现场为准`
                      : route.reason}
                </p>
                {route.status === 'ready' && route.warnings.length > 1 && (
                  <small>{route.warnings.slice(1).join(' ')}</small>
                )}
              </div>
              {route.status === 'ready' && (
                <button className="campus-v2-primary" onClick={() => engine.current?.fitRoute(route)}>
                  查看全路线
                  <Maximize size={15} />
                </button>
              )}
            </div>
            <div className="campus-v2-route-actions">
              <button
                onClick={() => {
                  user();
                  dispatch({ type: 'origin' });
                }}
              >
                更改起点
              </button>
              <button
                disabled={!selection.origin || !p}
                onClick={() => {
                  user();
                  dispatch({ type: 'swap' });
                }}
              >
                交换两端
              </button>
              <button
                onClick={() => {
                  user();
                  dispatch({ type: 'clear' });
                }}
              >
                清除
              </button>
              {selection.mode === 'two' && (
                <button
                  onClick={() => {
                    user();
                    dispatch({ type: 'current' });
                  }}
                >
                  从本机位置出发
                </button>
              )}
              {route.status === 'error' && (
                <button onClick={() => dispatch({ type: 'retry' })}>重试路线</button>
              )}
            </div>
          </section>
        )}
        <footer className="campus-v2-footer">
          <div>
            <div ref={scale} className="campus-v2-scale">
              100 m
            </div>
            <button
              className="campus-v2-attribution"
              onClick={() => void api.openLink('https://www.openstreetmap.org/copyright')}
            >
              © OpenStreetMap contributors
            </button>
          </div>
          <span ref={coverage} className="campus-v2-coverage" hidden>
            此处超出数据覆盖范围
          </span>
          <button
            className="campus-v2-location-state"
            onClick={() => {
              setAbout(true);
              setHelp(false);
            }}
          >
            {locationLabel(location)}
          </button>
          <button
            className="campus-v2-help"
            aria-label="地图操作说明"
            onClick={() => {
              setHelp(!help);
              setAbout(false);
            }}
          >
            ?
          </button>
        </footer>
        {about && (
          <div className="campus-v2-about campus-v2-floating" role="region" aria-label="地图来源与覆盖范围">
            <div className="campus-v2-floating-head">
              <strong>关于这张地图</strong>
              <button aria-label="关闭地图说明" onClick={() => setAbout(false)}>
                <X size={17} />
              </button>
            </div>
            <p>
              紫金港校区与望月公寓（桂花苑）周边。建筑、水系与道路来自开放地理数据，地图可离线浏览和规划。
            </p>
            {data && (
              <>
                <dl>
                  <div>
                    <dt>建筑</dt>
                    <dd>{data.manifest.buildings} 栋可选</dd>
                  </div>
                  <div>
                    <dt>可用入口</dt>
                    <dd>{data.manifest.connectedEntrances} 个已连接路网</dd>
                  </div>
                  <div>
                    <dt>到楼路线</dt>
                    <dd>{data.manifest.routableBuildings} 栋有已知连接</dd>
                  </div>
                  <div>
                    <dt>数据时间</dt>
                    <dd>{data.manifest.sourceDate.slice(0, 10)}</dd>
                  </div>
                </dl>
                <p>
                  未记录的建筑与道路没有用虚构图形补齐。地图之外仍可能有道路；现实门禁、施工和未标注限制不在本地快照内。
                </p>
              </>
            )}
            <strong>{location.source === 'test' ? '测试位置（模拟）' : '这台 Windows 电脑的位置'}</strong>
            <p>
              {location.reason}
              {location.fix && (
                <>
                  {' '}
                  精度约 {Math.round(location.fix.accuracy)} 米，采集于{' '}
                  {new Date(location.fix.timestamp).toLocaleTimeString('zh-CN')}。
                </>
              )}
            </p>
            <p>未连接手机位置。地图关闭后停止定位，不保存轨迹。</p>
            {tracking.current && (
              <button className="campus-v2-stop-location" onClick={stopLocation}>
                停止本机定位
              </button>
            )}
            <div className="campus-v2-source-links">
              <button onClick={() => void api.openLink('https://map.zju.edu.cn/index')}>
                浙大官方地图 ↗
              </button>
              <button onClick={() => void api.openLink('https://www.openstreetmap.org/copyright')}>
                OSM · ODbL 许可 ↗
              </button>
            </div>
          </div>
        )}
        {help && (
          <div className="campus-v2-about campus-v2-floating" role="region" aria-label="地图操作说明">
            <div className="campus-v2-floating-head">
              <strong>轻轻拨动这张地图</strong>
              <button aria-label="关闭操作说明" onClick={() => setHelp(false)}>
                <X size={17} />
              </button>
            </div>
            <dl>
              <div>
                <dt>平移</dt>
                <dd>拖动或方向键</dd>
              </div>
              <div>
                <dt>缩放</dt>
                <dd>滚轮、双指或 + / −</dd>
              </div>
              <div>
                <dt>旋转</dt>
                <dd>Shift + 拖动、双指或 Q / E</dd>
              </div>
              <div>
                <dt>回北 / 校园</dt>
                <dd>N / 0</dd>
              </div>
              <div>
                <dt>选择建筑</dt>
                <dd>点按轮廓，或搜索后 Enter</dd>
              </div>
            </dl>
            <p>
              键盘快捷键在地图获得焦点时生效。两点路线先选 A，再选 B；此后点选只更换
              B。随时拖动即可接管自动镜头。
            </p>
          </div>
        )}
      </div>
    </dialog>
  );
}
function fromWgs84([lon, lat]: number[]) {
  return [(6378137 * lon * Math.PI) / 180, 6378137 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
}
function locationLabel(location: LocationStatusResult) {
  const labels: Record<LocationStatusResult['status'], string> = {
    idle: '可手动选择起点',
    requesting: '正在获取本机位置',
    fresh: '本机位置已更新',
    approximate: '本机位置精度较低',
    outside: '本机位置在范围外',
    stale: '位置已过期',
    denied: '定位未获授权',
    unavailable: '本机定位暂不可用',
  };
  return (location.source === 'test' ? '测试 · ' : '') + labels[location.status];
}
