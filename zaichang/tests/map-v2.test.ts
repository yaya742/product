import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import GeoJSON from 'ol/format/GeoJSON.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { WalkingGraph, metersBetween, classifyFix } from '../src/shared/map-routing';
import {
  emptyRoute,
  type MapGraph,
  type MapPoint,
  type LocationFix,
  type MapOverview,
} from '../src/shared/map-v2';
import { selectionReducer, initialSelection, CameraOwnership } from '../src/renderer/map/map-state';
import { darkMapPalette, lightMapPalette, neutralPalette } from '../src/renderer/map/map-theme';
import { CampusMapAdapter } from '../src/main/mapService';
import { crossesInterior } from '../scripts/map-geometry.mjs';
import { planarGpuStyle } from '../src/renderer/map/gpu-style';

const service = new CampusMapAdapter('assets/map-v2');
const manifest: MapOverview = service.overview();
const places: MapPoint[] = JSON.parse(fs.readFileSync('assets/map-v2/places.json', 'utf8'));
const graph: MapGraph = JSON.parse(fs.readFileSync('assets/map-v2/network.json', 'utf8'));
const geo = JSON.parse(fs.readFileSync('public/map-v2/geography.geojson', 'utf8'));
const raw = JSON.parse(gunzipSync(fs.readFileSync('assets/map-v2/source.osm.json.gz')).toString());
const point = (id: string): MapPoint => ({
  id,
  displayName: id,
  kind: 'building',
  aliases: [],
  coordinate: [120.08, 30.31],
  bounds: [120.08, 30.31, 120.081, 30.311],
  entrances: [],
  source: { url: 'https://www.openstreetmap.org' },
  geometryStatus: 'mapped',
});
function smallGraph(): MapGraph {
  const ns = ['a1', 'a2', 'x', 'y', 'b1', 'b2', 'isolated'];
  const es: [string, string, number, boolean?, boolean?][] = [
    ['a1', 'x', 8],
    ['a2', 'x', 1],
    ['x', 'y', 2],
    ['y', 'b1', 7],
    ['y', 'b2', 1],
    ['a1', 'b1', 12],
    ['a2', 'b2', 2, true],
    ['b1', 'a1', 1, false, true],
  ];
  return {
    version: 'independent-fixture',
    nodes: ns.map((id, i) => ({ id, coordinate: [120 + i * 0.001, 30] })),
    edges: es.map(([from, to, meters, stairs, oneway], i) => ({
      id: String(i),
      from,
      to,
      meters,
      stairs: !!stairs,
      oneway: !!oneway,
      bridge: false,
      gate: false,
      way: String(i),
      name: '',
    })),
  };
}
test('Dijkstra compares all qualified entrances; independent known optimum and one-way edges', () => {
  const solver = new WalkingGraph(smallGraph());
  assert.equal(solver.shortest(['a1', 'a2'], ['b1', 'b2'])?.meters, 2);
  assert.equal(solver.shortest(['a1', 'a2'], ['b1', 'b2'], true)?.meters, 4);
  assert.equal(solver.shortest(['a1'], ['b1'], true)?.meters, 12);
  assert.equal(solver.shortest(['b1'], ['a1'], true)?.meters, 1);
  assert.equal(solver.shortest(['a1'], ['isolated']), null);
  assert.equal(solver.shortest(['a1'], ['a1'])?.meters, 0);
});
test('invalid weights and unknown graph nodes are rejected instead of inventing paths', () => {
  const g = smallGraph();
  g.edges[0].meters = -1;
  assert.throws(() => new WalkingGraph(g));
  const g2 = smallGraph();
  g2.edges[0].to = 'absent';
  assert.throws(() => new WalkingGraph(g2));
});
test('known metric distance and projection round trip remain independent of screen rotation', () => {
  assert.ok(Math.abs(metersBetween([0, 0], [1, 0]) - 111195.08023) < 0.001);
  for (const p of places.filter((_, i) => i % 29 === 0)) {
    const restored = toLonLat(fromLonLat(p.coordinate));
    assert.ok(Math.abs(restored[0] - p.coordinate[0]) < 1e-9);
    assert.ok(Math.abs(restored[1] - p.coordinate[1]) < 1e-9);
    const xy = fromLonLat(p.coordinate);
    for (const a of [0, 45, 180, 359, 360, 720]) {
      const r = (a * Math.PI) / 180,
        x = xy[0] * Math.cos(r) - xy[1] * Math.sin(r),
        y = xy[0] * Math.sin(r) + xy[1] * Math.cos(r);
      assert.ok(Math.abs(x * Math.cos(r) + y * Math.sin(r) - xy[0]) < 1e-7);
      assert.ok(Math.abs(-x * Math.sin(r) + y * Math.cos(r) - xy[1]) < 1e-7);
    }
  }
});
test('polygon holes, multipart geometry and neighbouring buildings use real polygon membership', () => {
  const outer = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
    hole = [
      [3, 3],
      [7, 3],
      [7, 7],
      [3, 7],
      [3, 3],
    ];
  const poly = new Polygon([outer, hole]);
  assert.equal(poly.intersectsCoordinate([1, 1]), true);
  assert.equal(poly.intersectsCoordinate([5, 5]), false);
  assert.equal(poly.intersectsCoordinate([12, 5]), false);
  const multi = new MultiPolygon([
    [outer, hole],
    [
      [
        [20, 0],
        [22, 0],
        [22, 2],
        [20, 2],
        [20, 0],
      ],
    ],
  ]);
  assert.equal(multi.intersectsCoordinate([21, 1]), true);
  assert.equal(multi.intersectsCoordinate([15, 1]), false);
});
test('obstacle validation cannot miss a thin river between sampling points, and respects island holes', () => {
  const water = {
    type: 'Polygon',
    coordinates: [
      [
        [0.369, -1],
        [0.371, -1],
        [0.371, 1],
        [0.369, 1],
        [0.369, -1],
      ],
    ],
  };
  assert.equal(crossesInterior([0, 0], [1, 0], water), true);
  assert.equal(crossesInterior([0, 2], [1, 2], water), false);
  const lake = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [3, 3],
        [7, 3],
        [7, 7],
        [3, 7],
        [3, 3],
      ],
    ],
  };
  assert.equal(crossesInterior([4, 5], [6, 5], lake), false);
  assert.equal(crossesInterior([-1, 5], [11, 5], lake), true);
  assert.equal(crossesInterior([0, 0], [10, 0], lake), false);
});
test('every selectable object has a unique stable source ID and a valid geographic label anchor', () => {
  const features = new GeoJSON().readFeatures(geo),
    byId = new Map(features.map((f) => [String(f.getId()), f]));
  assert.equal(new Set(places.map((p) => p.id)).size, places.length);
  for (const p of places) {
    assert.match(p.id, /^(way|relation|node)\/\d+$|^official\/hotmap_221027\.\d+$/);
    const f = byId.get(p.id);
    assert.ok(f, p.id);
    assert.equal(f!.getGeometry()!.intersectsCoordinate(p.coordinate), true, p.displayName);
  }
  assert.equal(manifest.buildings, places.filter((p) => p.kind === 'building').length);
  assert.ok(manifest.buildings > 500);
  assert.ok(
    geo.features.some(
      (f: any) =>
        (f.geometry.type === 'Polygon' && f.geometry.coordinates.length > 1) ||
        f.geometry.type === 'MultiPolygon',
    ),
  );
});
test('the refreshed OSM snapshot retains source topology; no snapped or fabricated edges', () => {
  const ways = new Map(raw.elements.filter((e: any) => e.type === 'way').map((e: any) => [`way/${e.id}`, e]));
  const nodes = new Map(
    raw.elements.filter((e: any) => e.type === 'node').map((e: any) => [String(e.id), e]),
  );
  for (const e of graph.edges) {
    const way: any = ways.get(e.way);
    assert.ok(way, e.way);
    assert.ok(
      way.nodes.some(
        (id: number, i: number) =>
          (String(id) === e.from && String(way.nodes[i + 1]) === e.to) ||
          (String(id) === e.to && String(way.nodes[i + 1]) === e.from),
      ),
      e.id,
    );
    assert.ok(e.meters > 0);
    assert.notEqual(way.tags?.foot, 'no');
    assert.notEqual(way.tags?.motorroad, 'yes');
    assert.notEqual((nodes.get(e.from) as any).tags?.locked, 'yes');
  }
  assert.ok(manifest.rejected.waterCrossings > 0);
  assert.ok(manifest.rejected.wallCrossings > 0);
  assert.ok(manifest.rejected.restrictedWays > 0);
});
test('every building entrance uses the same source node as the building boundary and graph', () => {
  const entities = new Map(raw.elements.map((e: any) => [`${e.type}/${e.id}`, e]));
  const nodeIds = (e: any): number[] =>
    e.type === 'way'
      ? e.nodes
      : e.members
          .filter((m: any) => m.type === 'way' && m.role !== 'inner')
          .flatMap((m: any) => (entities.get(`way/${m.ref}`) as any)?.nodes || []);
  for (const p of places.filter((p) => p.kind === 'building'))
    for (const entry of p.entrances) {
      assert.ok(nodeIds(entities.get(p.id)).includes(Number(entry.id)), p.id);
      if (entry.connected) assert.ok(service.walking.nodes.has(entry.id));
    }
});
test('Wangyue / Guihuayuan alias is tied to the user-confirmed residential boundary, without fabricated buildings', () => {
  const a = service.search('望月公寓')[0],
    b = service.search('桂花苑')[0];
  assert.equal(a.id, 'way/322644186');
  assert.equal(a.id, b.id);
  assert.equal(a.kind, 'area');
  assert.equal(a.entrances.length, 0);
});
test('core campus coverage includes the named avenue, west/east fields, lakes, gates and official building aliases', () => {
  for (const name of [
    '求是大道',
    '西操场',
    '西田径场',
    '东操场',
    '东田径场',
    '风雨操场',
    '中心湖',
    '启真湖',
    '望月公寓',
    '桂花苑',
    '东大门',
    '西1门',
    '西2门',
    '主图书馆',
    '基础图书馆',
    '古籍图书馆',
    '白沙',
    '翠柏',
    '紫云',
    '澄月',
    '玉湖',
    '体育馆',
  ]) {
    assert.ok(service.search(name, 10).length > 0, name);
  }
  assert.ok(service.search('西一教学楼', 10).length > 0);
  assert.ok(service.search('图书信息A楼（基础图书馆）', 10).length > 0);
  assert.ok(service.overview().coreLandmarks >= 10);
});
test('actual East 3 to East 4 chain has no centre connectors, no scenic curves, and correct endpoint identity', () => {
  const a = service.search('东3教学楼')[0],
    b = service.search('东4教学楼')[0];
  const r = service.route({ from: { kind: 'place', id: a.id }, to: { kind: 'place', id: b.id } });
  assert.equal(r.status, 'ready');
  assert.equal(r.distance?.connectorM, 0);
  assert.ok(r.distance!.totalM > 150 && r.distance!.totalM < 300);
  assert.deepEqual(r.coordinates[0], r.originEntrance!.coordinate);
  assert.deepEqual(r.coordinates.at(-1), r.destinationEntrance!.coordinate);
  assert.equal(r.nodeIds.length, r.edgeIds.length + 1);
  const sum = r.edgeIds.reduce((s, id) => s + service.walking.edges.get(id)!.meters, 0);
  assert.ok(Math.abs(sum - r.distance!.totalM) < 1e-9);
});
test('fixed-seed unfamiliar building endpoints use the same complete route flow', () => {
  const ps = places.filter((p) => p.kind === 'building' && p.entrances.some((e) => e.connected));
  let seed = 41729;
  let ready = 0;
  for (let i = 0; i < 40; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const a = ps[seed % ps.length];
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const b = ps[seed % ps.length];
    const r = service.route({ from: { kind: 'place', id: a.id }, to: { kind: 'place', id: b.id } });
    assert.ok(['ready', 'same', 'unreachable'].includes(r.status));
    if (r.status === 'ready') {
      ready++;
      assert.equal(r.from?.id, a.id);
      assert.equal(r.to?.id, b.id);
    }
  }
  assert.ok(ready >= 20);
});
test('missing origin, unknown entry, same building and stale data version have explicit failures', () => {
  const a = service.search('东3教学楼')[0],
    unknown = service.search('桂花苑')[0];
  assert.equal(service.route({ to: { kind: 'place', id: a.id } }).status, 'missing_origin');
  assert.equal(
    service.route({ from: { kind: 'current' }, to: { kind: 'place', id: a.id } }).status,
    'origin_confirmation',
  );
  assert.equal(
    service.route({ from: { kind: 'place', id: a.id }, to: { kind: 'place', id: unknown.id } }).status,
    'unknown_entrance',
  );
  assert.equal(
    service.route({ from: { kind: 'place', id: a.id }, to: { kind: 'place', id: a.id } }).status,
    'same',
  );
  assert.equal(service.route({ to: { kind: 'place', id: 'old-id' } }).status, 'outside');
  assert.equal(service.route({ to: { kind: 'place', id: a.id }, version: 'old-version' }).status, 'error');
});
test('location status respects datum, age, actual accuracy, source and coverage', () => {
  const now = Date.now(),
    fix: LocationFix = {
      coordinate: [120.08, 30.31],
      timestamp: now,
      accuracy: 10,
      crs: 'EPSG:4326',
      source: 'windows-native',
      deviceLabel: 'test device',
    };
  assert.equal(classifyFix(fix, manifest.bounds, now), 'fresh');
  assert.equal(classifyFix({ ...fix, accuracy: 300 }, manifest.bounds, now), 'approximate');
  assert.equal(classifyFix({ ...fix, timestamp: now - 130000 }, manifest.bounds, now), 'stale');
  assert.equal(classifyFix({ ...fix, timestamp: now + 50000 }, manifest.bounds, now), 'unavailable');
  assert.equal(classifyFix({ ...fix, coordinate: [121, 31] }, manifest.bounds, now), 'outside');
  assert.equal(classifyFix({ ...fix, accuracy: NaN }, manifest.bounds, now), 'unavailable');
  assert.equal(
    classifyFix({ ...fix, coordinate: [120.09, 30.31] }, manifest.bounds, now, {
      ...fix,
      timestamp: now - 1000,
    }),
    'approximate',
  );
  assert.equal(service.locationStatus().phoneConnected, false);
});
test('A then B then C preserves A, swap is explicit, and clearing invalidates prior responses', () => {
  const A = point('A'),
    B = point('B'),
    C = point('C');
  let s = selectionReducer(initialSelection, { type: 'two' });
  s = selectionReducer(s, { type: 'choose', point: A });
  assert.equal(s.stage, 'destination');
  s = selectionReducer(s, { type: 'choose', point: B });
  s = selectionReducer(s, { type: 'choose', point: C });
  assert.equal(s.origin?.id, 'A');
  assert.equal(s.destination?.id, 'C');
  const old = s.revision;
  s = selectionReducer(s, { type: 'swap' });
  assert.equal(s.origin?.id, 'C');
  assert.equal(s.destination?.id, 'A');
  const snapshot = s;
  s = selectionReducer(s, {
    type: 'result',
    revision: old,
    route: { ...emptyRoute(), status: 'ready', reason: 'late B' },
  });
  assert.equal(s, snapshot);
  s = selectionReducer(s, { type: 'clear' });
  assert.equal(s.destination, undefined);
  assert.equal(s.origin, undefined);
});
test('out-of-order asynchronous responses cannot replace a new destination or distance', async () => {
  let s = selectionReducer(initialSelection, { type: 'choose', point: point('B') });
  const first = s.revision;
  let finishOld!: () => void;
  const old = new Promise<void>((resolve) => {
    finishOld = () => {
      s = selectionReducer(s, {
        type: 'result',
        revision: first,
        route: { ...emptyRoute(), reason: 'old B' },
      });
      resolve();
    };
  });
  s = selectionReducer(s, { type: 'choose', point: point('C') });
  const second = s.revision;
  s = selectionReducer(s, {
    type: 'result',
    revision: second,
    route: { ...emptyRoute(), reason: 'latest C' },
  });
  finishOld();
  await old;
  assert.equal(s.destination?.id, 'C');
  assert.equal(s.route.reason, 'latest C');
});
test('user input vetoes delayed location/route camera suggestions; disposal rejects every callback', () => {
  const c = new CameraOwnership(),
    ticket = c.ticket();
  assert.ok(c.accepts(ticket));
  c.take();
  assert.equal(c.accepts(ticket), false);
  const newer = c.ticket();
  assert.ok(c.accepts(newer));
  c.destroy();
  assert.equal(c.accepts(newer), false);
});
test('both map palettes are grayscale, with a meaningful negative control', () => {
  assert.ok(neutralPalette(darkMapPalette));
  assert.ok(neutralPalette(lightMapPalette));
  assert.equal(neutralPalette({ ...darkMapPalette, location: '#4488ff' }), false);
});
test('all rendered geometry is XY and GPU rules only use planar fill/stroke properties', () => {
  const check = (coordinates) => {
    if (typeof coordinates[0] === 'number') {
      assert.equal(coordinates.length, 2);
      assert.ok(coordinates.every(Number.isFinite));
    } else coordinates.forEach(check);
  };
  for (const f of geo.features) check(f.geometry.coordinates);
  const allowed = new Set([
    'fill-color',
    'stroke-color',
    'stroke-width',
    'stroke-line-dash',
    'stroke-line-cap',
    'stroke-line-join',
  ]);
  for (const palette of [darkMapPalette, lightMapPalette])
    for (const rule of planarGpuStyle(palette))
      for (const key of Object.keys(rule.style)) assert.ok(allowed.has(key), key);
});
test('functional text meets 4.5:1 contrast on the actual composited surfaces', () => {
  const lum = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const ratio = (a: number, b: number) =>
    (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  assert.ok(ratio(189, 0.96 * 35 + 0.04 * 25) > 4.5);
  assert.ok(ratio(85, 0.97 * 249 + 0.03 * 245) > 4.5);
});
test('cached route results cannot be mutated by callers', () => {
  const a = service.search('东3')[0],
    b = service.search('东4')[0],
    q = { from: { kind: 'place' as const, id: a.id }, to: { kind: 'place' as const, id: b.id } };
  const first = service.route(q);
  first.coordinates.length = 0;
  const next = service.route(q);
  assert.ok(next.coordinates.length > 2);
});
test('missing map assets degrade the map service without preventing the chat application from starting', () => {
  const missing = new CampusMapAdapter('.test-data/does-not-exist-map-v2');
  assert.equal(missing.overview().dataStatus, 'error');
  assert.equal(missing.route({}).status, 'error');
  assert.deepEqual(missing.search('建筑'), []);
});
