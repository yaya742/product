import Layer from 'ol/layer/Layer';
import type VectorSource from 'ol/source/Vector';
import type Feature from 'ol/Feature';
import type Style from 'ol/style/Style';
import type Geometry from 'ol/geom/Geometry';
import type { FrameState } from 'ol/Map';

type Batch = {
  path: Path2D;
  fill?: string;
  stroke?: string;
  width: number;
  dash: number[];
  cap: CanvasLineCap;
  join: CanvasLineJoin;
  z: number;
  pass: number;
};
const color = (c: unknown): string | undefined =>
  typeof c === 'string' ? c : Array.isArray(c) ? `rgba(${c[0]},${c[1]},${c[2]},${c[3] ?? 1})` : undefined;
/** Native Path2D batches, not a cached screenshot. Every camera frame draws the
 * complete geographic paths through OpenLayers' current 2D transform. Batching
 * avoids thousands of JS draw calls without cropping distant camera transitions.
 */
export function geometryLayer(
  source: VectorSource,
  style: (feature: Feature, resolution: number) => Style | Style[] | undefined,
  revision: () => number,
) {
  const canvas = document.createElement('canvas');
  canvas.className = 'ol-layer campus-v2-geography';
  Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
  let context = canvas.getContext('2d');
  if (!context) throw new Error('二维画布无法创建，请重新打开地图。');
  const ext = source.getExtent();
  if (!ext || !ext.every(Number.isFinite)) throw new Error('未取得有效的地图几何，请重新加载。');
  const origin = [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2];
  let batches: Batch[] = [],
    lastKey = '';
  function line(path: Path2D, points: number[][], close = false, positive?: boolean) {
    if (!points.length) return;
    let coords = points;
    if (positive !== undefined) {
      let area = 0;
      for (let i = 1; i < points.length; i++)
        area +=
          (points[i - 1][0] - origin[0]) * (points[i][1] - origin[1]) -
          (points[i][0] - origin[0]) * (points[i - 1][1] - origin[1]);
      if (area > 0 !== positive) coords = points.slice().reverse();
    }
    path.moveTo(coords[0][0] - origin[0], coords[0][1] - origin[1]);
    for (let i = 1; i < coords.length; i++) path.lineTo(coords[i][0] - origin[0], coords[i][1] - origin[1]);
    if (close) path.closePath();
  }
  function add(path: Path2D, g: Geometry) {
    const type = g.getType();
    const coordinates = (
      g as Geometry & { getCoordinates(): number[][] | number[][][] | number[][][][] }
    ).getCoordinates();
    if (type === 'LineString') line(path, coordinates as number[][]);
    else if (type === 'MultiLineString') (coordinates as number[][][]).forEach((p) => line(path, p));
    else if (type === 'Polygon')
      (coordinates as number[][][]).forEach((ring, i) => line(path, ring, true, i === 0));
    else if (type === 'MultiPolygon')
      (coordinates as number[][][][]).forEach((p) => p.forEach((ring, i) => line(path, ring, true, i === 0)));
  }
  function rebuild(resolution: number) {
    const groups = new Map<string, Batch>();
    for (const feature of source.getFeatures()) {
      const geometry = feature.getGeometry();
      if (!geometry) continue;
      const result = style(feature, resolution);
      if (!result) continue;
      const styles = Array.isArray(result) ? result : [result];
      styles.forEach((s, index) => {
        const stroke = s.getStroke(),
          fill = color(s.getFill()?.getColor()),
          strokeColor = color(stroke?.getColor());
        if (!fill && !strokeColor) return;
        const width = stroke?.getWidth() ?? 1,
          dash = stroke?.getLineDash() || [],
          cap = stroke?.getLineCap() || 'round',
          join = stroke?.getLineJoin() || 'round',
          z = s.getZIndex() ?? 0,
          pass = styles.length > 1 ? index : 1;
        const key = JSON.stringify([fill, strokeColor, width, dash, cap, join, z, pass]);
        let batch = groups.get(key);
        if (!batch) {
          batch = { path: new Path2D(), fill, stroke: strokeColor, width, dash, cap, join, z, pass };
          groups.set(key, batch);
        }
        add(batch.path, geometry);
      });
    }
    batches = [...groups.values()].sort((a, b) => a.z - b.z || a.pass - b.pass);
  }
  const render = (frame: FrameState) => {
    const ratio = frame.pixelRatio,
      [w, h] = frame.size,
      width = Math.round(w * ratio),
      height = Math.round(h * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    if (!context) return canvas;
    const key = `${source.getRevision()}/${revision()}`;
    if (key !== lastKey) {
      rebuild(frame.viewState.resolution);
      lastKey = key;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    const m = frame.coordinateToPixelTransform;
    context.setTransform(
      ratio * m[0],
      ratio * m[1],
      ratio * m[2],
      ratio * m[3],
      ratio * (m[4] + origin[0] * m[0] + origin[1] * m[2]),
      ratio * (m[5] + origin[0] * m[1] + origin[1] * m[3]),
    );
    for (const batch of batches) {
      if (batch.fill) {
        context.fillStyle = batch.fill;
        context.fill(batch.path, 'nonzero');
      }
      if (batch.stroke) {
        context.strokeStyle = batch.stroke;
        context.lineWidth = batch.width * frame.viewState.resolution;
        context.lineCap = batch.cap;
        context.lineJoin = batch.join;
        context.setLineDash(batch.dash.map((d) => d * frame.viewState.resolution));
        context.stroke(batch.path);
      }
    }
    canvas.dataset.batches = String(batches.length);
    return canvas;
  };
  const layer = new Layer({ source, render });
  const restored = () => {
    context = canvas.getContext('2d');
    lastKey = '';
    layer.changed();
  };
  canvas.addEventListener('contextrestored', restored);
  return {
    layer,
    dispose: () => {
      canvas.removeEventListener('contextrestored', restored);
      batches = [];
      canvas.width = 1;
      canvas.height = 1;
      layer.dispose();
    },
  };
}
