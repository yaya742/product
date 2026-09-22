// Rebuild only from a fresh, bounded OSM export. Never reads the retired map assets.
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import osmtogeojson from 'osmtogeojson';
import { contains, crossesInterior } from './map-geometry.mjs';

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/import-map-v2.mjs <bounded-overpass.json>');
const sourceBytes = await fs.readFile(input);
const raw = JSON.parse((input.endsWith('.gz') ? gunzipSync(sourceBytes) : sourceBytes).toString('utf8'));
const retrievedAt = raw._zaichangRetrievedAt || (await fs.stat(input)).mtime.toISOString();
const coreReferencePath = path.resolve('assets/map-v2/core-reference.json');
const coreReference = await fs
  .readFile(coreReferencePath, 'utf8')
  .then((s) => JSON.parse(s))
  .catch(() => ({ landmarks: [], sources: [] }));
const officialCoveragePath = path.resolve('assets/map-v2/official-coverage-reference.json');
const officialCoverage = await fs
  .readFile(officialCoveragePath, 'utf8')
  .then((s) => JSON.parse(s))
  .catch(() => ({ records: [] }));
if (raw.remark || !Array.isArray(raw.elements)) throw new Error('Incomplete Overpass response');
const bbox = [120.06, 30.293, 120.101, 30.326];
const inside = ([x, y]) => x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
const nodes = new Map(raw.elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
const ways = raw.elements.filter((e) => e.type === 'way');
const entities = new Map(raw.elements.map((e) => [`${e.type}/${e.id}`, e]));
const ll = (n) => [n.lon, n.lat];
const radians = Math.PI / 180;
function distance(a, b) {
  const h =
    Math.sin(((b[1] - a[1]) * radians) / 2) ** 2 +
    Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(((b[0] - a[0]) * radians) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function extent(g) {
  const points = [];
  const visit = (a) => (typeof a[0] === 'number' ? points.push(a) : a.forEach(visit));
  visit(g.coordinates);
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])),
  ];
}
function anchor(g) {
  const b = extent(g),
    center = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  if (contains(center, g)) return center;
  // Prefer the widest interior part when a centroid lies in a courtyard.
  const rings = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flat(),
    cos = Math.cos(center[1] * radians);
  let best,
    score = -1;
  for (let y = 1; y < 25; y++)
    for (let x = 1; x < 25; x++) {
      const p = [b[0] + ((b[2] - b[0]) * x) / 25, b[1] + ((b[3] - b[1]) * y) / 25];
      if (!contains(p, g)) continue;
      let clearance = Infinity;
      for (const ring of rings)
        for (let i = 1; i < ring.length; i++) {
          const a = ring[i - 1],
            c = ring[i],
            dx = (c[0] - a[0]) * cos,
            dy = c[1] - a[1];
          const t = Math.max(
            0,
            Math.min(1, ((p[0] - a[0]) * cos * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
          );
          clearance = Math.min(clearance, ((p[0] - a[0]) * cos - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2);
        }
      if (clearance > score) {
        score = clearance;
        best = p;
      }
    }
  if (best) return best;
  return g.type === 'Polygon' ? g.coordinates[0][0] : g.coordinates[0][0][0];
}
const geo = osmtogeojson(raw, { flatProperties: true });
const regions = geo.features.filter((f) => ['way/288874844', 'way/322644186'].includes(f.id));
const features = [];
const places = [];
const waters = [];
for (const f of geo.features) {
  const t = f.properties,
    id = f.id;
  if (!f.geometry || t.tainted) continue;
  const polygon = ['Polygon', 'MultiPolygon'].includes(f.geometry.type);
  const kind =
    t.building && t.building !== 'no' && polygon
      ? 'building'
      : t.natural === 'water' && polygon
        ? 'water'
        : t.waterway
          ? 'waterway'
          : t.highway
            ? 'road'
              : t.barrier
                ? 'barrier'
                : polygon && (t.amenity || t.public_transport || t.historic || t.tourism)
                  ? 'landmark'
                : polygon && (t.amenity === 'university' || t.landuse === 'residential')
                ? 'area'
                : polygon && (t.leisure || t.landuse)
                  ? 'land'
                  : null;
  if (!kind || f.geometry.type === 'Point') continue;
  const b = extent(f.geometry);
  if (b[2] < bbox[0] || b[0] > bbox[2] || b[3] < bbox[1] || b[1] > bbox[3]) continue;
  const coordinates = [];
  const visit = (a) => (typeof a[0] === 'number' ? coordinates.push(a) : a.forEach(visit));
  visit(f.geometry.coordinates);
  const scope = coordinates.some((p) => regions.some((r) => contains(p, r.geometry))) ? 'campus' : 'context';
  const p = {
    id,
    kind,
    scope,
    name: t['name:zh'] || t.name || '',
    highway: t.highway,
    waterway: t.waterway,
    barrier: t.barrier,
    landuse: t.landuse,
    leisure: t.leisure,
    bridge: t.bridge,
    tunnel: t.tunnel,
    layer: t.layer,
    version: entities.get(id)?.version,
    timestamp: entities.get(id)?.timestamp,
  };
  features.push({ type: 'Feature', id, properties: p, geometry: f.geometry });
  if (kind === 'water') waters.push({ geometry: f.geometry, bounds: b });
  if (kind === 'building' || kind === 'area' || kind === 'landmark') {
    const a = anchor(f.geometry);
    if (kind === 'area' && !inside(a)) continue;
    const aliases = [t.alt_name, t.short_name, t['name:en']].filter(Boolean).flatMap((s) => s.split(';'));
    // The user explicitly identified this neighbourhood by this second name.
    if (id === 'way/322644186') aliases.push('桂花苑', '望月公寓（桂花苑）');
    const name = p.name || `未命名建筑 · ${id.split('/')[1]}`;
    places.push({
      id,
      displayName: name,
      aliases,
      kind,
      coordinate: a,
      bounds: b,
      entrances: [],
      source: { url: `https://www.openstreetmap.org/${id}`, version: p.version, updatedAt: p.timestamp },
      geometryStatus: 'mapped',
    });
  }
}
const accessYes = (t) => ['yes', 'designated', 'permissive'].includes(t.foot);
function accessible(t = {}) {
  if (
    t.locked === 'yes' ||
    t.entrance === 'exit' ||
    t.entrance === 'emergency' ||
    t.entrance === 'service' ||
    t.entrance === 'no'
  )
    return false;
  if (['no', 'private', 'customers', 'delivery', 'permit', 'destination', 'use_sidepath'].includes(t.foot))
    return false;
  if (
    !accessYes(t) &&
    ['no', 'private', 'customers', 'delivery', 'permit', 'destination', 'agricultural', 'forestry'].includes(
      t.access,
    )
  )
    return false;
  if (Object.keys(t).some((k) => /^(access|foot):conditional$/.test(k))) return false;
  if (
    t.barrier &&
    ![
      'gate',
      'lift_gate',
      'swing_gate',
      'bollard',
      'cycle_barrier',
      'entrance',
      'kerb',
      'cattle_grid',
    ].includes(t.barrier)
  )
    return false;
  return true;
}
const allowed = new Set([
  'footway',
  'path',
  'pedestrian',
  'steps',
  'living_street',
  'residential',
  'service',
  'unclassified',
  'tertiary',
  'tertiary_link',
  'secondary',
  'secondary_link',
  'primary',
  'primary_link',
  'track',
]);
function walkable(t = {}) {
  return (
    (allowed.has(t.highway) || (t.highway === 'cycleway' && accessYes(t))) &&
    accessible(t) &&
    t.area !== 'yes' &&
    t.motorroad !== 'yes' &&
    !t.construction &&
    t.indoor !== 'yes' &&
    (!t.level || t.level === '0')
  );
}
const graphNodes = new Map(),
  edges = [],
  rejected = { restrictedWays: 0, waterCrossings: 0, missingNodes: 0, outside: 0, blockedNodes: 0 };
const entranceWayNodes = new Map();
const barriers = ways.filter(
  (w) =>
    ['wall', 'fence', 'retaining_wall'].includes(w.tags?.barrier) && (!w.tags.layer || w.tags.layer === '0'),
);
const wallNodes = new Set(barriers.flatMap((w) => w.nodes));
const explicitOpening = (n) =>
  !!n.tags?.barrier &&
  ['gate', 'lift_gate', 'swing_gate', 'entrance', 'bollard', 'cycle_barrier'].includes(n.tags.barrier) &&
  accessible(n.tags);
const wallSegments = barriers.flatMap((w) =>
  w.nodes
    .slice(1)
    .flatMap((id, i) =>
      nodes.has(id) && nodes.has(w.nodes[i])
        ? [[ll(nodes.get(w.nodes[i])), ll(nodes.get(id)), w.nodes[i], id]]
        : [],
    ),
);
rejected.wallCrossings = 0;
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function intersects(a, b, c, d) {
  return cross(a, b, c) * cross(a, b, d) < -1e-24 && cross(c, d, a) * cross(c, d, b) < -1e-24;
}
for (const w of ways.filter((w) => w.tags?.highway)) {
  if (!walkable(w.tags)) {
    rejected.restrictedWays++;
    continue;
  }
  for (let i = 1; i < w.nodes.length; i++) {
    const a = nodes.get(w.nodes[i - 1]),
      b = nodes.get(w.nodes[i]);
    if (!a || !b) {
      rejected.missingNodes++;
      continue;
    }
    const pa = ll(a),
      pb = ll(b);
    if (!inside(pa) || !inside(pb)) {
      rejected.outside++;
      continue;
    }
    if (
      !accessible(a.tags) ||
      !accessible(b.tags) ||
      (((wallNodes.has(a.id) && !explicitOpening(a)) || (wallNodes.has(b.id) && !explicitOpening(b))) &&
        w.tags.bridge !== 'yes' &&
        w.tags.tunnel !== 'yes')
    ) {
      rejected.blockedNodes++;
      continue;
    }
    const len = distance(pa, pb);
    if (!Number.isFinite(len) || len <= 0) continue;
    if (w.tags.bridge !== 'yes' && w.tags.tunnel !== 'yes') {
      const crossed = waters.some(
        (w) =>
          Math.max(pa[0], pb[0]) >= w.bounds[0] &&
          Math.min(pa[0], pb[0]) <= w.bounds[2] &&
          Math.max(pa[1], pb[1]) >= w.bounds[1] &&
          Math.min(pa[1], pb[1]) <= w.bounds[3] &&
          crossesInterior(pa, pb, w.geometry),
      );
      if (crossed) {
        rejected.waterCrossings++;
        continue;
      }
      if (
        wallSegments.some(
          ([c, d, cid, did]) =>
            ![cid, did].includes(a.id) && ![cid, did].includes(b.id) && intersects(pa, pb, c, d),
        )
      ) {
        rejected.wallCrossings++;
        continue;
      }
    }
    for (const n of [a, b])
      graphNodes.set(String(n.id), {
        id: String(n.id),
        coordinate: ll(n),
        entrance: n.tags?.entrance,
        name: n.tags?.name,
        barrier: n.tags?.barrier,
      });
    const edge = {
      id: `way/${w.id}:${i - 1}`,
      from: String(a.id),
      to: String(b.id),
      meters: len,
      way: `way/${w.id}`,
      name: w.tags.name || '',
      stairs: w.tags.highway === 'steps',
      bridge: w.tags.bridge === 'yes',
      gate: !!a.tags?.barrier || !!b.tags?.barrier,
    };
    // Motor vehicle one-way restrictions do not imply pedestrian one-way.
    const oneway = w.tags['oneway:foot'];
    if (oneway === '-1') [edge.from, edge.to] = [edge.to, edge.from];
    edge.oneway = ['yes', '1', '-1'].includes(oneway);
    edges.push(edge);
    for (const n of [a, b]) if (n.tags?.entrance && accessible(n.tags)) entranceWayNodes.set(n.id, n);
  }
}
function objectNodeIds(e) {
  if (e?.type === 'way') return e.nodes;
  return (
    e?.members
      ?.filter((m) => m.type === 'way' && m.role !== 'inner')
      .flatMap((m) => entities.get(`way/${m.ref}`)?.nodes || []) || []
  );
}
for (const p of places) {
  const ids = [...new Set(objectNodeIds(entities.get(p.id)))];
  p.entrances = ids
    .filter((id) => nodes.get(id)?.tags?.entrance && accessible(nodes.get(id).tags))
    .map((id) => ({
      id: String(id),
      coordinate: ll(nodes.get(id)),
      name: nodes.get(id).tags.name || (nodes.get(id).tags.entrance === 'main' ? '主入口' : '入口'),
      connected: graphNodes.has(String(id)),
      source: `https://www.openstreetmap.org/node/${id}`,
    }));
  // Named residential/campus boundaries may expose real gates rather than building entrances.
  if (p.kind === 'area')
    for (const id of ids)
      if (
        graphNodes.has(String(id)) &&
        nodes.get(id)?.tags?.barrier?.includes('gate') &&
        accessible(nodes.get(id).tags)
      )
        p.entrances.push({
          id: String(id),
          coordinate: ll(nodes.get(id)),
          name: nodes.get(id).tags.name || '出入口',
          connected: true,
          source: `https://www.openstreetmap.org/node/${id}`,
        });
}
// Add a small, explicit core-landmark layer after source normalization. OSM
// entries keep their source geometry; a public-map name-only reference gets a
// tiny location marker and is never added to the walking graph.
const placeIds = new Set(places.map((p) => p.id));
const featureById = new Map(features.map((f) => [String(f.id), f]));
function pointBounds([lon, lat], radius = 0.000035) {
  return [lon - radius, lat - radius, lon + radius, lat + radius];
}
function circlePolygon([lon, lat], radius = 0.000035) {
  const ring = [];
  for (let i = 0; i <= 16; i++) {
    const a = (Math.PI * 2 * i) / 16;
    ring.push([lon + Math.cos(a) * radius, lat + Math.sin(a) * radius]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}
for (const landmark of coreReference.landmarks || []) {
  const id = String(landmark.id);
  if (id.startsWith('official/')) {
    if (!Array.isArray(landmark.coordinate) || landmark.coordinate.length !== 2) continue;
    const source = coreReference.sources?.find((s) => s.kind === 'zju-public-wfs');
    features.push({
      type: 'Feature',
      id,
      properties: {
        id,
        kind: 'landmark',
        scope: 'campus',
        name: landmark.name,
        sourceKind: 'zju-public-wfs',
        geometryStatus: 'reference-point',
      },
      geometry: circlePolygon(landmark.coordinate),
    });
    places.push({
      id,
      displayName: landmark.name,
      aliases: [...new Set(landmark.aliases || [])],
      kind: 'landmark',
      coordinate: landmark.coordinate,
      bounds: pointBounds(landmark.coordinate),
      entrances: [],
      source: {
        url: source?.url || 'https://map.zju.edu.cn/index',
        featureId: source?.featureId,
        updatedAt: source?.retrievedAt || coreReference.retrievedAt,
      },
      geometryStatus: 'reference-point',
    });
    continue;
  }
  const sourceId = id.replace(/^node\//, 'node/');
  if (placeIds.has(id)) {
    const p = places.find((candidate) => candidate.id === id);
    p.aliases = [...new Set([...(p.aliases || []), ...(landmark.aliases || [])])];
    if (landmark.name && p.displayName.startsWith('未命名')) p.displayName = landmark.name;
    continue;
  }
  const feature = featureById.get(id);
  const node = id.startsWith('node/') ? nodes.get(Number(id.slice(5))) : undefined;
  const coordinate = node ? ll(node) : feature ? anchor(feature.geometry) : undefined;
  if (!coordinate || !inside(coordinate)) continue;
  const bounds = feature ? extent(feature.geometry) : pointBounds(coordinate);
  places.push({
    id,
    displayName: landmark.name,
    aliases: [...new Set(landmark.aliases || [])],
    kind: 'landmark',
    coordinate,
    bounds,
    entrances: [],
    source: { url: `https://www.openstreetmap.org/${id}`, updatedAt: coreReference.retrievedAt },
    geometryStatus: feature ? 'mapped' : 'reference-point',
  });
  if (!feature) {
    features.push({
      type: 'Feature',
      id,
      properties: { id, kind: 'landmark', scope: 'campus', name: landmark.name, sourceKind: 'osm' },
      geometry: circlePolygon(coordinate),
    });
  } else {
    feature.properties = { ...feature.properties, name: landmark.name, kind: 'landmark', scope: 'campus' };
  }
}
const placesById = new Map(places.map((p) => [p.id, p]));
let officialAliasCount = 0;
for (const record of officialCoverage.records || []) {
  if (!record.mappedPlaceId || record.nearestDistanceM > 25) continue;
  const place = placesById.get(record.mappedPlaceId);
  if (!place || !record.name || place.displayName === record.name) continue;
  if (!place.aliases.includes(record.name)) {
    place.aliases.push(record.name);
    officialAliasCount++;
  }
}
const sourceDate = raw.osm3s?.timestamp_osm_base;
const sanitized = {
  ...raw,
  _zaichangRetrievedAt: retrievedAt,
  elements: raw.elements.map(({ user, uid, changeset, ...e }) => e),
};
const rawBytes = Buffer.from(JSON.stringify(sanitized));
const version = `osm-${sourceDate?.slice(0, 10)}-${createHash('sha256')
  .update(rawBytes)
  .update(JSON.stringify([features, places, [...graphNodes.values()], edges]))
  .digest('hex')
  .slice(0, 12)}`;
const manifest = {
  schemaVersion: 'campus-map/v2',
  version,
  sourceDate,
  acquiredAt: retrievedAt,
  bounds: bbox,
  campusBounds: [120.063, 30.296, 120.088, 30.319],
  label: '紫金港 · 望月公寓（桂花苑）',
  crs: 'EPSG:4326',
  coordinateOrder: 'longitude, latitude',
  renderProjection: 'EPSG:3857',
  distance: 'haversine, mean Earth radius 6371008.8 m',
  license: 'ODbL-1.0',
  attribution: '© OpenStreetMap contributors',
  source: 'https://overpass-api.de/api/interpreter',
  copyright: 'https://www.openstreetmap.org/copyright',
  buildings: places.filter((p) => p.kind === 'building').length,
  selectable: places.length,
  coreLandmarks: places.filter((p) => p.kind === 'landmark').length,
  officialCoverageRecords: officialCoverage.records?.length || 0,
  officialAliasesApplied: officialAliasCount,
  officialUnresolvedNames: (officialCoverage.records || []).filter((r) => !r.mappedPlaceId).length,
  entrances: places.reduce((s, p) => s + p.entrances.length, 0),
  connectedEntrances: places.reduce((s, p) => s + p.entrances.filter((e) => e.connected).length, 0),
  routableBuildings: places.filter((p) => p.kind === 'building' && p.entrances.some((e) => e.connected))
    .length,
  nodes: graphNodes.size,
  edges: edges.length,
  features: features.length,
  rejected,
  limitations: [
    'OSM 是开放社区数据，不是浙大官方测绘或实时通行保证。',
    '建筑入口仅依据同一 OSM 节点与道路的真实拓扑连接；不按最近距离吸附。',
    '未知、受限或未连通入口不输出建筑路线；数据边缘不代表现实道路终止。',
    '桂花苑别名来自用户提供，绑定 OSM 望月公寓边界；未推断其中的楼号或入口。',
  ],
};
const out = path.resolve('assets/map-v2'),
  pub = path.resolve('public/map-v2');
await fs.mkdir(out, { recursive: true });
await fs.mkdir(pub, { recursive: true });
await fs.writeFile(path.join(out, 'source.osm.json.gz'), gzipSync(rawBytes));
await fs.writeFile(
  path.join(out, 'network.json'),
  JSON.stringify({ version, nodes: [...graphNodes.values()], edges }),
);
await fs.writeFile(path.join(out, 'places.json'), JSON.stringify(places));
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
await fs.writeFile(
  path.join(pub, 'geography.geojson'),
  JSON.stringify({ type: 'FeatureCollection', features }),
);
await fs.writeFile(path.join(pub, 'places.json'), JSON.stringify(places));
await fs.writeFile(path.join(pub, 'manifest.json'), JSON.stringify(manifest, null, 2));
await fs.writeFile(path.join(pub, 'source.osm.json.gz'), gzipSync(rawBytes));
console.log(JSON.stringify(manifest, null, 2));
