import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import path from 'node:path';

const raw = JSON.parse(zlib.gunzipSync(await fs.readFile('assets/map-v2/source.osm.json.gz')));
const geo = JSON.parse(await fs.readFile('public/map-v2/geography.geojson'));
const places = JSON.parse(await fs.readFile('public/map-v2/places.json'));
const manifest = JSON.parse(await fs.readFile('assets/map-v2/manifest.json'));
const official = JSON.parse(await fs.readFile('assets/map-v2/official-coverage-reference.json'));
const report = { schemaVersion: 'map-coverage-audit/v1', auditedAt: new Date().toISOString(), mapVersion: manifest.version, rounds: [], warnings: [] };
const sourceGeometryIds = new Set(raw.elements.filter((e) => (e.type === 'way' || e.type === 'relation') && e.tags && (e.tags.building || e.tags.natural === 'water' || e.tags.waterway || e.tags.highway || e.tags.leisure || e.tags.landuse || e.tags.amenity)).map((e) => `${e.type}/${e.id}`));
const geoIds = new Set(geo.features.map((f) => String(f.id)));
const buildingIds = new Set(raw.elements.filter((e) => (e.type === 'way' || e.type === 'relation') && e.tags?.building && e.tags.building !== 'no').map((e) => `${e.type}/${e.id}`));
const geoBuildingIds = new Set(geo.features.filter((f) => f.properties?.kind === 'building').map((f) => String(f.id)));
const finiteCoords = (coords) => {
  if (typeof coords[0] === 'number') return coords.length === 2 && coords.every(Number.isFinite);
  return coords.every(finiteCoords);
};
report.rounds.push({
  id: 'R1-source-to-render',
  question: '源数据中的建筑几何是否完整进入渲染数据？',
  sourceBuildingCount: buildingIds.size,
  renderedBuildingCount: geoBuildingIds.size,
  missingBuildingIds: [...buildingIds].filter((id) => !geoBuildingIds.has(id)),
  duplicateFeatureIds: geo.features.map((f) => String(f.id)).filter((id, i, all) => all.indexOf(id) !== i),
  invalidGeometryCount: geo.features.filter((f) => !f.geometry || !finiteCoords(f.geometry.coordinates)).length,
});
const namedGeometry = raw.elements.filter((e) => (e.type === 'way' || e.type === 'relation') && (e.tags?.name || e.tags?.['name:zh']));
report.rounds.push({
  id: 'R2-named-source-preservation',
  question: '源中的命名地理对象是否仍可在渲染层查到？',
  sourceNamedGeometryCount: namedGeometry.length,
  renderedNamedFeatureCount: geo.features.filter((f) => f.properties?.name).length,
  missingNamedIds: namedGeometry.map((e) => `${e.type}/${e.id}`).filter((id) => !geoIds.has(id)),
});
const core = ['求是大道', '西操场', '西田径场', '东操场', '东田径场', '风雨操场', '中心湖', '启真湖', '望月公寓', '桂花苑', '东大门', '西1门', '西2门', '主图书馆', '基础图书馆', '古籍图书馆', '白沙', '翠柏', '紫云', '澄月', '玉湖', '食堂', '体育馆'];
const searchable = places.flatMap((p) => [p.displayName, ...(p.aliases || [])]);
const coreResults = Object.fromEntries(core.map((name) => [name, searchable.some((value) => value.includes(name))]));
report.rounds.push({ id: 'R3-core-components', question: '用户指定的核心道路、场地、水体、校门与建筑是否存在于搜索覆盖？', required: coreResults, missing: core.filter((name) => !coreResults[name]) });
const officialNames = official.records.filter((r) => r.name?.trim());
const officialMapped = officialNames.filter((r) => r.mappedPlaceId).length;
const officialUnresolved = officialNames.filter((r) => !r.mappedPlaceId).map((r) => ({ officialId: r.officialId, name: r.name, nearestDistanceM: r.nearestDistanceM, displayLevel: r.displayLevel }));
report.rounds.push({ id: 'R4-current-official-name-crosscheck', question: '当前公开官方名称层与 OSM 几何的空间映射是否被诚实记录？', sourceRecords: officialNames.length, aliasesApplied: manifest.officialAliasesApplied, mappedWithin25m: officialMapped, unresolvedCount: officialUnresolved.length, unresolved: officialUnresolved });
const coreIds = new Set(['official/hotmap_221027.1321', 'way/161322822', 'way/817997263', 'way/161417081', 'relation/9772853', 'relation/7927357', 'node/3300077166', 'node/12961372149', 'node/12961372151']);
report.rounds.push({ id: 'R5-core-geometry', question: '核心对象是否有稳定几何或明确名称锚点？', objects: [...coreIds].map((id) => { const p = places.find((x) => x.id === id); const f = geo.features.find((x) => String(x.id) === id); return { id, place: !!p, feature: !!f, displayName: p?.displayName, geometryStatus: p?.geometryStatus, geometryType: f?.geometry?.type }; }) });
report.rounds.push({ id: 'R6-manifest-consistency', question: '清单统计是否与生成文件一致？', checks: { buildings: manifest.buildings === places.filter((p) => p.kind === 'building').length, selectable: manifest.selectable === places.length, features: manifest.features === geo.features.length, coreLandmarks: manifest.coreLandmarks === places.filter((p) => p.kind === 'landmark').length } });
report.status = report.rounds[0].missingBuildingIds.length === 0 && report.rounds[0].invalidGeometryCount === 0 && report.rounds[2].missing.length === 0 && Object.values(report.rounds[5].checks).every(Boolean) ? 'passed_with_documented_official_gaps' : 'failed';
if (officialUnresolved.length) report.warnings.push('当前官方名称层中仍有名称未在 25 米内绑定到 OSM 建筑；这些对象未被静默伪绑定，详见 R4。');
await fs.mkdir('artifacts/map-v2', { recursive: true });
await fs.writeFile('artifacts/map-v2/coverage-audit.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, rounds: report.rounds.map((r) => ({ id: r.id, missing: r.missing?.length || 0 })), officialUnresolved: officialUnresolved.length }));
if (report.status === 'failed') process.exitCode = 1;
