/** Explicit, bounded refresh. The application itself never downloads an Overpass dataset. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
const run = promisify(execFile);
const dir = path.resolve('.test-data/map-v2-download');
await fs.mkdir(dir, { recursive: true });
const query = `[out:json][timeout:60][bbox:30.293,120.060,30.326,120.101];
(way["building"];relation["building"];way["highway"];relation["highway"]["type"="multipolygon"];
way["waterway"];way["natural"="water"];relation["natural"="water"];way["landuse"];relation["landuse"];
way["leisure"];relation["leisure"];way["amenity"="university"];relation["amenity"="university"];
way["barrier"];node["barrier"];node["entrance"];);(._;>;);out meta;`;
await fs.writeFile(path.join(dir, 'query.txt'), query);
const file = path.join(dir, 'source.json');
const args = [
  '--fail',
  '--silent',
  '--show-error',
  '--location',
  '--max-time',
  '80',
  '--max-filesize',
  '20000000',
  '--retry',
  '1',
  '--retry-delay',
  '3',
  'https://overpass-api.de/api/interpreter',
  '--data-urlencode',
  `data@${path.join(dir, 'query.txt')}`,
  '--output',
  file,
];
if (process.argv.includes('--direct')) args.unshift('--noproxy', '*');
await run(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
  maxBuffer: 1024 * 1024,
  windowsHide: true,
});
const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
if (parsed.remark || !parsed.elements?.length)
  throw new Error('Source is incomplete; existing map was not changed.');
parsed._zaichangRetrievedAt = new Date().toISOString();
await fs.writeFile(file, JSON.stringify(parsed));
await run(process.execPath, ['scripts/import-map-v2.mjs', file], {
  maxBuffer: 1024 * 1024,
  windowsHide: true,
}).then((r) => console.log(r.stdout));
