import fs from 'node:fs/promises';
import path from 'node:path';

const input = process.argv[2] || '.test-data/current-official-zijin.json';
const official = JSON.parse(await fs.readFile(input, 'utf8'));
const places = JSON.parse(await fs.readFile('assets/map-v2/places.json', 'utf8'));
const sourceUrl = 'https://map.zju.edu.cn/geoserver/wfs';

function utmToLonLat(easting, northing) {
  const deg = Math.PI / 180, a = 6378137, ecc = 0.00669438, k0 = 0.9996;
  const x = easting - 500000, y = northing;
  const e1 = (1 - Math.sqrt(1 - ecc)) / (1 + Math.sqrt(1 - ecc));
  const m = y / k0, mu = m / (a * (1 - ecc / 4 - (3 * ecc ** 2) / 64 - (5 * ecc ** 3) / 256));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
  const c1 = ecc / (1 - ecc) * Math.cos(p1) ** 2, t1 = Math.tan(p1) ** 2;
  const n1 = a / Math.sqrt(1 - ecc * Math.sin(p1) ** 2), r1 = a * (1 - ecc) / (1 - ecc * Math.sin(p1) ** 2) ** 1.5;
  const d = x / (n1 * k0);
  const lat = p1 - (n1 * Math.tan(p1) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * (ecc / (1 - ecc)) * Math.cos(p1) ** 2) * d ** 4 / 24);
  const lon = (123 * deg) + (d - (1 + 2 * t1 + c1) * d ** 3 / 6) / Math.cos(p1);
  return [lon / deg, lat / deg];
}
function officialToWgs(x, y) {
  const rot = 30 * Math.PI / 180, compressed = y / Math.cos(45 * Math.PI / 180);
  const east = Math.cos(rot) * x - Math.sin(rot) * compressed;
  const north = Math.sin(rot) * x + Math.cos(rot) * compressed;
  return utmToLonLat(east, north);
}
const meters = (a, b) => Math.hypot((a[0] - b[0]) * 93000, (a[1] - b[1]) * 111000);
const chineseDigits = new Map([['一','1'],['二','2'],['三','3'],['四','4'],['五','5'],['六','6'],['七','7'],['八','8'],['九','9'],['十','10']]);
const normalize = (s) => String(s || '').replace(/[（）()\s·]/g, '').replaceAll('校区', '').replaceAll('学园', '').replaceAll('幢', '舍').replace(/[一二三四五六七八九十]/g, (d) => chineseDigits.get(d) || d);
const similarName = (a, b) => {
  const x = normalize(a), y = normalize(b);
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const numsX = x.match(/\d+/g) || [], numsY = y.match(/\d+/g) || [];
  if (!numsX.length || !numsY.length || !numsX.every((n) => numsY.includes(n))) return false;
  const stemX = x.replace(/\d+/g, ''), stemY = y.replace(/\d+/g, '');
  return stemX.slice(0, 2) === stemY.slice(0, 2);
};
const candidates = places.filter((p) => p.kind === 'building' || p.kind === 'area');
const records = official.features.filter((f) => f.properties?.name?.trim()).map((f) => {
  const p = f.properties, coordinate = Number.isFinite(p.x) && Number.isFinite(p.y) ? officialToWgs(p.x, p.y) : null;
  const ranked = coordinate ? candidates.map((candidate) => ({ id: candidate.id, name: candidate.displayName, distanceM: meters(coordinate, candidate.coordinate) })).sort((a, b) => a.distanceM - b.distanceM) : [];
  const named = ranked.find((candidate) => candidate.distanceM <= 50 && similarName(p.name, candidate.name));
  const best = named || (ranked[0]?.distanceM <= 25 ? ranked[0] : null);
  return {
    officialId: f.id,
    name: p.name,
    displayLevel: p.displayLevel ?? null,
    entityType: p.entityType || null,
    coordinate,
    mappedPlaceId: best && best.distanceM <= 25 ? best.id : null,
    nearestDistanceM: best?.distanceM ?? null,
  };
});
const out = {
  schemaVersion: 'campus-map/official-coverage-reference/v1',
  retrievedAt: new Date().toISOString(),
  source: sourceUrl,
  layer: 'IMAP:hotmap_221027',
  projection: 'EPSG:32651 transformed from current public map 2.5D coordinates',
  note: 'Names and point coordinates are used for coverage cross-reference and search aliases only. Official 2.5D polygons are not copied into the renderer or walking graph.',
  records,
};
await fs.writeFile('assets/map-v2/official-coverage-reference.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({records: records.length, mapped: records.filter((r) => r.mappedPlaceId).length, unresolved: records.filter((r) => !r.mappedPlaceId).length}));
