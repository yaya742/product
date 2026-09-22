import Map from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import GeoJSON from 'ol/format/GeoJSON';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import Layer from 'ol/layer/Layer';
import WebGLVectorLayer from 'ol/layer/WebGLVector';
import { Fill, Stroke, Style, Text, Circle as CircleStyle } from 'ol/style';
import { Point, LineString, Polygon, MultiPolygon, MultiPoint, Circle as CircleGeometry } from 'ol/geom';
import type Geometry from 'ol/geom/Geometry';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj';
import { defaults as interactions } from 'ol/interaction/defaults';
import DragRotate from 'ol/interaction/DragRotate';
import PinchRotate from 'ol/interaction/PinchRotate';
import { shiftKeyOnly } from 'ol/events/condition';
import { easeOut } from 'ol/easing';
import { unByKey } from 'ol/Observable';
import { getCenter } from 'ol/extent';
import type { Bounds, LocationFix, MapOverview, MapPoint, MapRouteResult, LngLat } from '../../shared/map-v2';
import { CameraOwnership } from './map-state';
import { darkMapPalette, lightMapPalette, type MapPalette } from './map-theme';
import { geometryLayer } from './geometry-layer';
import { planarGpuStyle } from './gpu-style';

export interface SavedCamera {
  center: number[];
  resolution: number;
  rotation: number;
}
export interface MapData {
  manifest: MapOverview;
  places: MapPoint[];
  geography: object;
}
export interface MapCallbacks {
  choose: (p: MapPoint) => void;
  candidates: (ps: MapPoint[]) => void;
  hover: (p?: MapPoint) => void;
  blank: () => void;
  camera: (camera: SavedCamera) => void;
  user: () => void;
  ready: () => void;
}
const gray = (hex: string, alpha: number) => {
  const n = parseInt(hex.slice(1, 3), 16);
  return `rgba(${n},${n},${n},${alpha})`;
};

/** Strictly planar XY vectors: no pitch, altitude, terrain, extrusion or world copies. */
export class PlanarCampusMap {
  readonly map: Map;
  readonly view: View;
  readonly ownership = new CameraOwnership();
  private source: VectorSource;
  private highlight = new VectorSource();
  private routeSource = new VectorSource();
  private locationSource = new VectorSource();
  private selected?: string;
  private origin?: string;
  private hovered?: string;
  private hoverLevels = new globalThis.Map<string, number>();
  private frame = 0;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private blockedClick = 0;
  private pointIndex: globalThis.Map<string, MapPoint>;
  private palette: MapPalette;
  private dark = matchMedia('(prefers-color-scheme: dark)');
  private reduce = matchMedia('(prefers-reduced-motion: reduce)');
  private contrast = matchMedia('(prefers-contrast: more)');
  private baseLayer: Layer | WebGLVectorLayer<VectorSource>;
  private geography?: ReturnType<typeof geometryLayer>;
  private styleRevision = 0;
  private labelLayer: VectorLayer<VectorSource>;
  private overlayLayer: VectorLayer<VectorSource>;
  private routeLayer: VectorLayer<VectorSource>;
  private locationLayer: VectorLayer<VectorSource>;
  private styles = new globalThis.Map<string, Style | Style[]>();
  private observer: ResizeObserver;
  private cleanup: (() => void)[] = [];
  private renderCount = 0;
  private lastScale = '';
  private detailedNames = false;
  private detailedRoads = false;
  private closeScale = false;
  private loadedAt = performance.now();
  private disposed = false;
  constructor(
    private target: HTMLDivElement,
    readonly data: MapData,
    private callbacks: MapCallbacks,
    saved?: SavedCamera,
  ) {
    this.palette = this.dark.matches ? darkMapPalette : lightMapPalette;
    this.pointIndex = new globalThis.Map(data.places.map((p) => [p.id, p]));
    const features = new GeoJSON().readFeatures(data.geography, {
      dataProjection: 'EPSG:4326',
      featureProjection: 'EPSG:3857',
    });
    this.source = new VectorSource({ features, wrapX: false });
    for (const feature of features)
      for (const key of ['highway', 'bridge', 'tunnel'])
        if (feature.get(key) === undefined) feature.set(key, '', true);
    const ext = transformExtent(data.manifest.bounds, 'EPSG:4326', 'EPSG:3857');
    const margin = 1200;
    this.view = new View({
      center: saved?.center || getCenter(ext),
      resolution: saved?.resolution,
      zoom: saved ? undefined : 15.5,
      rotation: saved?.rotation || 0,
      constrainRotation: false,
      enableRotation: true,
      constrainResolution: false,
      minZoom: 13.5,
      maxZoom: 20,
      extent: [ext[0] - margin, ext[1] - margin, ext[2] + margin, ext[3] + margin],
      constrainOnlyCenter: true,
      smoothExtentConstraint: false,
      smoothResolutionConstraint: false,
      multiWorld: false,
    });
    const probe = document.createElement('canvas').getContext('webgl');
    if (probe) {
      probe.getExtension('WEBGL_lose_context')?.loseContext();
      this.baseLayer = new WebGLVectorLayer({
        className: 'campus-v2-geography-gl',
        source: this.source,
        style: planarGpuStyle(this.palette, this.contrast.matches),
        variables: { near: 0, paths: 0 },
        disableHitDetection: true,
      });
      target.dataset.renderer = 'webgl-2d';
    } else {
      this.geography = geometryLayer(
        this.source,
        (f, r) => this.baseStyle(f, r),
        () => this.styleRevision,
      );
      this.baseLayer = this.geography.layer;
      target.dataset.renderer = 'canvas-2d-fallback';
    }
    const labelFeatures = features
      .filter((f) => !!f.get('name'))
      .map((f) => {
        const p = this.pointIndex.get(String(f.getId()));
        const g = f.getGeometry();
        let anchor = p
          ? fromLonLat(p.coordinate)
          : g instanceof Polygon
            ? g.getInteriorPoint().getCoordinates()
            : g instanceof MultiPolygon
              ? g.getInteriorPoints().getCoordinates()[0]
              : undefined;
        if (!anchor || f.get('kind') === 'road' || f.get('kind') === 'barrier') return null;
        return new Feature({
          geometry: new Point(anchor.slice(0, 2)),
          name: f.get('name'),
          kind: f.get('kind'),
          sourceId: String(f.getId()),
        });
      })
      .filter((f): f is Feature<Point> => !!f);
    this.labelLayer = new VectorLayer({
      source: new VectorSource({ features: labelFeatures, wrapX: false }),
      declutter: true,
      style: (f, r) => this.labelStyle(f as Feature, r),
      updateWhileAnimating: true,
      updateWhileInteracting: true,
    });
    this.overlayLayer = new VectorLayer({
      source: this.highlight,
      style: (f) => this.highlightStyle(f as Feature),
      updateWhileAnimating: true,
      updateWhileInteracting: true,
    });
    this.routeLayer = new VectorLayer({
      className: 'campus-v2-route-layer',
      source: this.routeSource,
      style: (f) => this.routeStyle(f as Feature),
      updateWhileAnimating: true,
      updateWhileInteracting: true,
    });
    this.locationLayer = new VectorLayer({
      source: this.locationSource,
      style: (f) =>
        f.get('accuracy')
          ? new Style({
              fill: new Fill({ color: gray(this.palette.location, 0.045) }),
              stroke: new Stroke({ color: gray(this.palette.location, 0.32), width: 1 }),
            })
          : new Style({
              image: new CircleStyle({
                radius: 5,
                fill: new Fill({ color: this.palette.location }),
                stroke: new Stroke({ color: this.palette.halo, width: 2 }),
              }),
              text: new Text({
                text: f.get('label') || '本机',
                offsetY: 19,
                font: '12px "Noto Sans SC Variable", sans-serif',
                fill: new Fill({ color: this.palette.text }),
                stroke: new Stroke({ color: this.palette.halo, width: 4 }),
              }),
            }),
    });
    this.map = new Map({
      target,
      view: this.view,
      layers: [this.baseLayer, this.labelLayer, this.overlayLayer, this.routeLayer, this.locationLayer],
      controls: [],
      interactions: interactions({
        altShiftDragRotate: false,
        pinchRotate: false,
        doubleClickZoom: false,
        keyboard: false,
        onFocusOnly: true,
      }).extend([
        new PinchRotate({ threshold: 0.04, duration: 160 }),
        new DragRotate({ condition: shiftKeyOnly }),
      ]),
      moveTolerance: 5,
    });
    const lost = (event: Event) => {
      event.preventDefault();
      queueMicrotask(() => {
        if (this.disposed || this.geography) return;
        this.view.cancelAnimations();
        const old = this.baseLayer;
        this.geography = geometryLayer(
          this.source,
          (f, r) => this.baseStyle(f, r),
          () => this.styleRevision,
        );
        this.baseLayer = this.geography.layer;
        this.map.getLayers().setAt(0, this.baseLayer);
        old.dispose();
        target.dataset.renderer = 'canvas-2d-fallback';
        this.map.render();
      });
    };
    target.addEventListener('webglcontextlost', lost, true);
    this.cleanup.push(() => target.removeEventListener('webglcontextlost', lost, true));
    if (!saved)
      this.view.fit(transformExtent(data.manifest.campusBounds, 'EPSG:4326', 'EPSG:3857'), {
        padding: [88, 68, 75, 28],
        duration: 0,
      });
    this.updateDetail();
    const onInput = () => {
      target.focus({ preventScroll: true });
      this.takeControl();
      this.setHover(undefined);
      this.callbacks.user();
    };
    target.addEventListener('pointerdown', onInput, { capture: true });
    target.addEventListener('wheel', onInput, { capture: true, passive: true });
    this.cleanup.push(
      () => target.removeEventListener('pointerdown', onInput, true),
      () => target.removeEventListener('wheel', onInput, true),
    );
    const keydown = (e: KeyboardEvent) => this.keyboard(e);
    target.addEventListener('keydown', keydown);
    this.cleanup.push(() => target.removeEventListener('keydown', keydown));
    const leave = () => this.setHover(undefined);
    target.addEventListener('pointerleave', leave);
    this.cleanup.push(() => target.removeEventListener('pointerleave', leave));
    const keys = [
      this.map.on('pointerdrag', () => {
        this.blockedClick = Date.now() + 180;
        this.setHover(undefined);
      }),
      this.map.on('pointermove', (e) => {
        if (e.dragging || this.view.getInteracting()) return;
        const points = this.hit(e.coordinate);
        this.setHover(points[0]);
        target.style.cursor = points.length ? 'pointer' : 'grab';
      }),
      this.map.on('click', (e) => {
        if (Date.now() < this.blockedClick) return;
        const points = this.hit(e.coordinate);
        const touch = e.originalEvent instanceof PointerEvent && e.originalEvent.pointerType === 'touch';
        if (!points.length && touch) {
          const toler = 9 * (this.view.getResolution() || 1);
          const nearby = this.source
            .getFeaturesInExtent([
              e.coordinate[0] - toler,
              e.coordinate[1] - toler,
              e.coordinate[0] + toler,
              e.coordinate[1] + toler,
            ])
            .filter((f) => f.get('kind') === 'building')
            .map((f) => this.pointIndex.get(String(f.getId())))
            .filter((p): p is MapPoint => !!p);
          if (nearby.length) {
            this.callbacks.candidates(nearby.slice(0, 6));
            return;
          }
        }
        if (points.length > 1 && touch) {
          this.callbacks.candidates(points.slice(0, 6));
          return;
        }
        if (points[0]) this.callbacks.choose(points[0]);
        else this.callbacks.blank();
      }),
      this.view.on('change', () => this.reportCamera()),
      this.view.on('change:resolution', () => this.updateDetail()),
      this.map.on('postrender', () => {
        this.renderCount++;
        target.dataset.renders = String(this.renderCount);
        this.reportCamera();
      }),
      this.map.once('rendercomplete', () => {
        target.dataset.ready = 'true';
        target.dataset.loadMs = (performance.now() - this.loadedAt).toFixed(1);
        if (!this.reduce.matches)
          target.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
        this.callbacks.ready();
      }),
    ];
    this.cleanup.push(() => unByKey(keys));
    const theme = () => {
      this.palette = this.dark.matches ? darkMapPalette : lightMapPalette;
      this.styles.clear();
      this.styleRevision++;
      if (this.baseLayer instanceof WebGLVectorLayer)
        this.baseLayer.setStyle(planarGpuStyle(this.palette, this.contrast.matches));
      [this.baseLayer, this.labelLayer, this.overlayLayer, this.routeLayer, this.locationLayer].forEach((l) =>
        l.changed(),
      );
    };
    this.dark.addEventListener('change', theme);
    this.contrast.addEventListener('change', theme);
    this.cleanup.push(
      () => this.dark.removeEventListener('change', theme),
      () => this.contrast.removeEventListener('change', theme),
    );
    const reduced = () => {
      if (this.reduce.matches) this.view.cancelAnimations();
    };
    this.reduce.addEventListener('change', reduced);
    this.cleanup.push(() => this.reduce.removeEventListener('change', reduced));
    this.observer = new ResizeObserver(() => {
      if (!this.disposed) {
        this.map.updateSize();
        this.reportCamera();
      }
    });
    this.observer.observe(target);
    const visible = () => {
      if (document.visibilityState === 'visible') {
        this.map.updateSize();
        this.map.render();
      }
    };
    document.addEventListener('visibilitychange', visible);
    this.cleanup.push(() => document.removeEventListener('visibilitychange', visible));
  }
  private baseStyle(f: Feature, res: number): Style | Style[] | undefined {
    const p = this.palette,
      kind = f.get('kind'),
      highway = f.get('highway'),
      close = this.closeScale;
    const context = f.get('scope') === 'context';
    const key = [
      kind,
      highway,
      close,
      this.detailedRoads,
      f.get('bridge'),
      f.get('tunnel'),
      context,
      this.contrast.matches,
    ].join('/');
    if (this.styles.has(key)) return this.styles.get(key);
    let style: Style | Style[] | undefined;
    if (kind === 'building')
      style = new Style({
        fill: new Fill({ color: gray(p.building, context ? 0.7 : 1) }),
        stroke: new Stroke({
          color: gray(this.contrast.matches ? p.text : p.outline, context ? 0.65 : 1),
          width: close ? 0.85 : 0.65,
        }),
        zIndex: 3,
      });
    if (kind === 'landmark')
      style = new Style({
        fill: new Fill({ color: gray(p.selected, 0.16) }),
        stroke: new Stroke({ color: p.selected, width: 1.2, lineDash: [3, 2] }),
        zIndex: 12,
      });
    if (kind === 'water')
      style = new Style({
        fill: new Fill({ color: p.water }),
        stroke: new Stroke({ color: gray(p.outline, 0.42), width: 0.7 }),
        zIndex: 0.5,
      });
    if (kind === 'land') style = new Style({ fill: new Fill({ color: gray(p.land, 0.7) }), zIndex: 0 });
    if (kind === 'area')
      style = new Style({
        stroke: new Stroke({ color: gray(p.outline, 0.23), width: 0.65, lineDash: [3, 5] }),
        zIndex: 0,
      });
    if (kind === 'waterway')
      style = new Style({ stroke: new Stroke({ color: p.water, width: close ? 3.5 : 2 }), zIndex: 1 });
    if (kind === 'barrier' && close)
      style = new Style({ stroke: new Stroke({ color: p.barrier, width: 0.8 }), zIndex: 3 });
    if (kind === 'road') {
      const major = /^(primary|secondary|tertiary|residential|living_street)/.test(highway || '');
      const pathlike = /^(path|footway|pedestrian|steps)/.test(highway || '');
      if (!this.detailedRoads && pathlike) return;
      const width = major ? (close ? 2.8 : 1.9) : pathlike ? (close ? 1.05 : 0.7) : 1.2;
      style = new Style({
        stroke: new Stroke({
          color: gray(major ? p.road : p.minorRoad, context ? 0.36 : 1),
          width: context ? width * 0.8 : width,
          lineDash: f.get('tunnel') === 'yes' ? [3, 4] : highway === 'steps' ? [1, 2] : undefined,
          lineCap: 'round',
          lineJoin: 'round',
        }),
        zIndex: 2,
      });
      if (f.get('bridge') === 'yes')
        style = [new Style({ stroke: new Stroke({ color: p.halo, width: width + 2.4 }), zIndex: 2 }), style];
    }
    if (style) this.styles.set(key, style);
    return style;
  }
  private labelStyle(f: Feature, res: number): Style | undefined {
    if (f.get('sourceId') === this.selected || f.get('sourceId') === this.origin) return;
    const kind = f.get('kind'),
      name = f.get('name') as string;
    if (kind === 'building' && !this.detailedNames && !/图书馆|博物馆|体育|食堂/.test(name)) return;
    if (kind === 'land' && res > 1.5) return;
    if (kind === 'area' && !/紫金港|望月/.test(name)) return;
    if (kind === 'landmark') {
      const landmarkKey = `label/landmark/${name}`;
      if (this.styles.has(landmarkKey)) return this.styles.get(landmarkKey) as Style;
      const landmarkStyle = new Style({
        text: new Text({
          text: name,
          font: '600 12px "Noto Sans SC Variable", sans-serif',
          fill: new Fill({ color: this.palette.text }),
          stroke: new Stroke({ color: this.palette.halo, width: 4 }),
          padding: [3, 4, 3, 4],
          rotateWithView: false,
        }),
        zIndex: 18,
      });
      this.styles.set(landmarkKey, landmarkStyle);
      return landmarkStyle;
    }
    const key = `label/${kind}/${name}`;
    if (this.styles.has(key)) return this.styles.get(key) as Style;
    const style = new Style({
      text: new Text({
        text: name,
        font: `${kind === 'area' ? '13' : '11'}px "Noto Sans SC Variable", "Microsoft YaHei", sans-serif`,
        fill: new Fill({
          color: kind === 'water' || kind === 'area' ? this.palette.secondaryText : this.palette.text,
        }),
        stroke: new Stroke({ color: this.palette.halo, width: 3 }),
        padding: [3, 4, 3, 4],
        overflow: false,
        rotateWithView: false,
      }),
      zIndex: kind === 'area' ? 10 : 5,
    });
    this.styles.set(key, style);
    return style;
  }
  private highlightStyle(f: Feature): Style[] {
    const p = this.palette,
      id = String(f.getId()),
      selected = id === this.selected || id === this.origin,
      a = selected ? 1 : this.hoverLevels.get(id) || 0;
    const styles = [
      new Style({
        fill: new Fill({ color: gray(selected ? p.selected : p.hover, selected ? 0.22 : 0.18 * a) }),
        stroke: new Stroke({
          color: gray(selected ? p.selected : p.hover, selected ? 1 : a),
          width: selected ? 1.45 : 1.1,
        }),
        zIndex: 10,
      }),
    ];
    const place = this.pointIndex.get(id);
    if (selected && place) {
      styles.push(
        new Style({
          geometry: new Point(fromLonLat(place.coordinate)),
          text: new Text({
            text: (id === this.origin ? 'A · ' : 'B · ') + place.displayName,
            font: '500 12px "Noto Sans SC Variable", sans-serif',
            fill: new Fill({ color: p.text }),
            stroke: new Stroke({ color: p.halo, width: 4 }),
            padding: [4, 5, 4, 5],
            offsetY: -9,
            rotateWithView: false,
          }),
          zIndex: 20,
        }),
      );
      for (const e of place.entrances)
        styles.push(
          new Style({
            geometry: new Point(fromLonLat(e.coordinate)),
            image: new CircleStyle({
              radius: 3,
              fill: new Fill({ color: e.connected ? p.selected : p.halo }),
              stroke: new Stroke({ color: p.selected, width: 1 }),
            }),
            zIndex: 15,
          }),
        );
    }
    return styles;
  }
  private routeStyle(f: Feature): Style | Style[] {
    const p = this.palette;
    if (f.get('endpoint'))
      return new Style({
        image: new CircleStyle({
          radius: f.get('endpoint') === 'A' ? 5 : 6,
          fill: new Fill({ color: f.get('endpoint') === 'A' ? p.halo : p.route }),
          stroke: new Stroke({ color: p.route, width: 2 }),
        }),
        text: new Text({
          text: f.get('endpoint'),
          offsetY: -17,
          font: '600 12px sans-serif',
          fill: new Fill({ color: p.text }),
          stroke: new Stroke({ color: p.halo, width: 4 }),
        }),
      });
    return [
      new Style({ stroke: new Stroke({ color: p.halo, width: 5.4, lineCap: 'round', lineJoin: 'round' }) }),
      new Style({ stroke: new Stroke({ color: p.route, width: 2.6, lineCap: 'round', lineJoin: 'round' }) }),
    ];
  }
  private hit(coordinate: number[]) {
    return this.source
      .getFeaturesAtCoordinate(coordinate)
      .filter((f) => ['building', 'landmark'].includes(f.get('kind')) || String(f.getId()) === 'way/322644186')
      .map((f) => this.pointIndex.get(String(f.getId())))
      .filter((p): p is MapPoint => !!p)
      .sort((a, b) => (a.kind === 'building' ? 0 : 1) - (b.kind === 'building' ? 0 : 1));
  }
  private cancelTooltip() {
    clearTimeout(this.hoverTimer);
    this.hoverTimer = undefined;
    this.callbacks.hover(undefined);
  }
  private setHover(point?: MapPoint) {
    if (point?.id === this.hovered) return;
    this.cancelTooltip();
    cancelAnimationFrame(this.frame);
    this.hovered = point?.id;
    if (point && !this.hoverLevels.has(point.id)) this.hoverLevels.set(point.id, 0);
    const levels = new globalThis.Map(this.hoverLevels);
    this.refreshHighlights();
    const started = performance.now();
    const tick = () => {
      if (this.disposed) return;
      const t = this.duration(130) === 0 ? 1 : Math.min(1, (performance.now() - started) / 130);
      for (const [id, level] of levels) {
        const target = id === this.hovered ? 1 : 0;
        this.hoverLevels.set(id, level + (target - level) * t);
        if (t === 1 && !target) this.hoverLevels.delete(id);
      }
      this.overlayLayer.changed();
      if (t < 1) this.frame = requestAnimationFrame(tick);
      else this.refreshHighlights();
    };
    tick();
    if (point)
      this.hoverTimer = setTimeout(() => {
        if (this.hovered === point.id) this.callbacks.hover(point);
      }, 330);
  }
  private refreshHighlights() {
    this.highlight.clear();
    for (const id of new Set([this.selected, this.origin, this.hovered, ...this.hoverLevels.keys()]))
      if (id) {
        const feature = this.source.getFeatureById(id);
        if (feature) {
          const copy = feature.clone();
          copy.setId(id);
          this.highlight.addFeature(copy);
        }
      }
  }
  select(destination?: MapPoint, origin?: MapPoint) {
    this.selected = destination?.id;
    this.origin = origin?.id;
    this.refreshHighlights();
    this.labelLayer.changed();
  }
  route(result: MapRouteResult) {
    this.routeSource.clear();
    this.target.dataset.routeStatus = result.status;
    if (result.status !== 'ready' || result.coordinates.length < 2) return;
    const coords = result.coordinates.map((c) => fromLonLat(c));
    this.routeSource.addFeatures([
      new Feature(new LineString(coords)),
      new Feature({ geometry: new Point(coords[0]), endpoint: 'A' }),
      new Feature({ geometry: new Point(coords.at(-1)!), endpoint: 'B' }),
    ]);
    const canvas = this.target.querySelector<HTMLCanvasElement>('.campus-v2-route-layer canvas');
    if (canvas && !this.reduce.matches)
      canvas.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  }
  location(fix?: LocationFix) {
    this.locationSource.clear();
    if (!fix) return;
    const p = fromLonLat(fix.coordinate),
      radius = fix.accuracy / Math.cos((fix.coordinate[1] * Math.PI) / 180);
    this.locationSource.addFeatures([
      new Feature({ geometry: new CircleGeometry(p, radius), accuracy: true }),
      new Feature({
        geometry: new Point(p),
        label:
          fix.source === 'test' ? '测试位置（模拟）' : fix.source === 'phone-synced' ? '已同步手机' : '本机',
      }),
    ]);
  }
  snapshot(): SavedCamera {
    return {
      center: this.view.getCenter()!.slice(),
      resolution: this.view.getResolution()!,
      rotation: this.view.getRotation(),
    };
  }
  private reportCamera() {
    if (this.disposed || !this.view.getCenter()) return;
    const camera = this.snapshot(),
      size = this.map.getSize() || [0, 0];
    this.target.dataset.camera = JSON.stringify({
      ...camera,
      size,
      pitch: 0,
      projection: 'EPSG:3857',
      animating: this.view.getAnimating(),
      interacting: this.view.getInteracting(),
    });
    const ground = camera.resolution * Math.cos((toLonLat(camera.center)[1] * Math.PI) / 180),
      desired = ground * 90;
    const power = 10 ** Math.floor(Math.log10(desired));
    const meters =
      [1, 2, 5, 10]
        .map((v) => v * power)
        .filter((v) => v <= desired)
        .at(-1) || power;
    const scale = JSON.stringify({ meters, width: meters / ground });
    if (scale !== this.lastScale) {
      this.target.dataset.scale = scale;
      this.lastScale = scale;
    }
    this.callbacks.camera(camera);
  }
  private updateDetail() {
    const r = this.view.getResolution() || 5;
    const before = [this.detailedNames, this.detailedRoads, this.closeScale].join('/');
    this.detailedNames = this.detailedNames ? r < 4.15 : r < 3.5;
    this.detailedRoads = this.detailedRoads ? r < 5.5 : r < 4.8;
    this.closeScale = this.closeScale ? r < 3.3 : r < 2.7;
    if (before !== [this.detailedNames, this.detailedRoads, this.closeScale].join('/')) this.styleRevision++;
    if (this.baseLayer instanceof WebGLVectorLayer)
      this.baseLayer.updateStyleVariables({
        near: this.closeScale ? 1 : 0,
        paths: this.detailedRoads ? 1 : 0,
      });
  }
  takeControl() {
    this.ownership.take();
    this.view.cancelAnimations();
  }
  private duration(ms: number) {
    return this.reduce.matches || this.geography ? 0 : ms;
  }
  zoom(delta: number) {
    this.takeControl();
    this.view.animate({
      zoom: (this.view.getZoom() || 16) + delta,
      duration: this.duration(180),
      easing: easeOut,
    });
  }
  rotate(delta: number) {
    this.takeControl();
    this.view.animate({
      rotation: this.view.getRotation() + delta,
      duration: this.duration(180),
      easing: easeOut,
    });
  }
  north() {
    this.takeControl();
    const r = this.view.getRotation(),
      turn = Math.round(r / (2 * Math.PI)) * 2 * Math.PI;
    this.view.animate({ rotation: turn, duration: this.duration(260), easing: easeOut });
  }
  overview() {
    this.takeControl();
    this.view.fit(transformExtent(this.data.manifest.campusBounds, 'EPSG:4326', 'EPSG:3857'), {
      padding: this.padding(),
      duration: this.duration(350),
      easing: easeOut,
    });
  }
  focusPlace(p: MapPoint) {
    this.takeControl();
    this.view.fit(transformExtent(p.bounds, 'EPSG:4326', 'EPSG:3857'), {
      padding: this.padding(),
      maxZoom: 18.5,
      duration: this.duration(320),
      easing: easeOut,
    });
  }
  private padding() {
    const bar = this.target.parentElement?.querySelector('.campus-v2-route')?.getBoundingClientRect(),
      rect = this.target.getBoundingClientRect();
    return [140, 80, bar ? Math.max(80, rect.bottom - bar.top + 20) : 70, 30];
  }
  fitRoute(result: MapRouteResult, ticket?: number) {
    if (result.status !== 'ready' || !result.coordinates.length) return;
    if (ticket !== undefined && !this.ownership.accepts(ticket)) return;
    if (ticket === undefined) this.takeControl();
    const wasAnimating = this.view.getAnimating();
    this.view.cancelAnimations();
    const fitCoordinates = result.coordinates.slice();
    for (const p of [result.from, result.to])
      if (p) {
        const [w, s, e, n] = p.bounds;
        fitCoordinates.push([w, s], [w, n], [e, s], [e, n]);
      }
    const coords = fitCoordinates.map((c) => fromLonLat(c)),
      size = this.map.getSize()!,
      pad = this.padding();
    const visible = coords.every((c) => {
      const p = this.map.getPixelFromCoordinate(c);
      return p[0] >= pad[3] && p[0] <= size[0] - pad[1] && p[1] >= pad[0] && p[1] <= size[1] - pad[2];
    });
    if (visible && !wasAnimating) return;
    this.view.cancelAnimations();
    this.view.fit(new MultiPoint(coords), {
      padding: pad,
      maxZoom: 18.3,
      duration: this.duration(340),
      easing: easeOut,
    });
  }
  locate(fix: LocationFix, intro = false, ticket?: number) {
    if (ticket !== undefined && !this.ownership.accepts(ticket)) return;
    if (!intro) this.takeControl();
    const center = fromLonLat(fix.coordinate);
    this.view.cancelAnimations();
    if (intro) {
      const extent = transformExtent(this.data.manifest.campusBounds, 'EPSG:4326', 'EPSG:3857'),
        size = this.map.getSize()!;
      const resolution =
        (Math.max(Math.abs(center[0] - extent[0]), Math.abs(extent[2] - center[0])) * 2) /
        Math.max(220, size[0] - 130);
      const vertical =
        (Math.max(Math.abs(center[1] - extent[1]), Math.abs(extent[3] - center[1])) * 2) /
        Math.max(180, size[1] - 230);
      const finalResolution = Math.min(10, Math.max(resolution, vertical));
      this.view.setCenter(center);
      if (this.duration(760)) {
        this.view.setZoom(18.2);
        this.view.animate(
          { center, duration: 190 },
          { center, resolution: finalResolution, duration: 760, easing: easeOut },
        );
      } else this.view.setResolution(finalResolution);
    } else this.view.animate({ center, zoom: 18, duration: this.duration(300), easing: easeOut });
  }
  private keyboard(e: KeyboardEvent) {
    if (e.target !== this.target) return;
    if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '=', '-', 'q', 'e', 'n', '0'].includes(e.key)
    ) {
      e.preventDefault();
      this.takeControl();
      this.callbacks.user();
      if (e.key === '+' || e.key === '=') this.zoom(0.5);
      else if (e.key === '-') this.zoom(-0.5);
      else if (e.key === 'q') this.rotate(-Math.PI / 12);
      else if (e.key === 'e') this.rotate(Math.PI / 12);
      else if (e.key === 'n') this.north();
      else if (e.key === '0') this.overview();
      else {
        const s = this.map.getSize()!,
          p = [s[0] / 2, s[1] / 2];
        p[0] += e.key === 'ArrowLeft' ? -75 : e.key === 'ArrowRight' ? 75 : 0;
        p[1] += e.key === 'ArrowUp' ? -75 : e.key === 'ArrowDown' ? 75 : 0;
        this.view.setCenter(this.map.getCoordinateFromPixel(p));
      }
    }
  }
  dispose() {
    this.disposed = true;
    this.ownership.destroy();
    this.view.cancelAnimations();
    clearTimeout(this.hoverTimer);
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.cleanup.forEach((f) => f());
    this.map.setTarget(undefined);
    this.map.dispose();
    if (this.geography) this.geography.dispose();
    else this.baseLayer.dispose();
    [this.labelLayer, this.overlayLayer, this.routeLayer, this.locationLayer].forEach((l) => l.dispose());
    this.target.getAnimations({ subtree: true }).forEach((a) => a.cancel());
  }
}
