import { deflateRawSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'dist', 'campus-zju-public-plugin.zip');
const files = [
  'plugin.json',
  'index.mjs',
  'connector/connector.json',
  'connector/LICENSE',
  'connector/SKILL.md',
  'connector/references/endpoints.json',
  'connector/scripts/zju.py',
  'connector/zju_connector/__init__.py',
  'connector/zju_connector/auth.py',
  'connector/zju_connector/cli.py',
  'connector/zju_connector/college_notices.py',
  'connector/zju_connector/credentials.py',
  'connector/zju_connector/holidays.py',
  'connector/zju_connector/http_client.py',
  'connector/zju_connector/normalize.py',
  'connector/zju_connector/notices.py',
  'connector/zju_connector/security.py',
  'connector/zju_connector/storage.py',
  'connector/zju_connector/sztz.py',
  'connector/zju_connector/zdbk.py',
];

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const local = [];
const central = [];
let offset = 0;

for (const name of files) {
  const nameBytes = Buffer.from(name);
  const value = readFileSync(path.join(root, name));
  const compressed = deflateRawSync(value);
  const checksum = crc32(value);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(value.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  local.push(localHeader, nameBytes, compressed);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(value.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt32LE(offset, 42);
  central.push(centralHeader, nameBytes);
  offset += localHeader.length + nameBytes.length + compressed.length;
}

const centralSize = central.reduce((sum, item) => sum + item.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat([...local, ...central, end]));
console.log(`已生成 ${output}`);
