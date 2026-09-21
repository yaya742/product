import { deflateRawSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve('examples/weather-plugin');
const output = path.resolve('artifacts/weather-plugin.zip');
const files = ['plugin.json', 'index.mjs'];
const local = [];
const central = [];
let offset = 0;

for (const name of files) {
  const nameBytes = Buffer.from(name);
  const value = readFileSync(path.join(root, name));
  const compressed = deflateRawSync(value);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(value.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  local.push(header, nameBytes, compressed);

  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(8, 10);
  directory.writeUInt32LE(compressed.length, 20);
  directory.writeUInt32LE(value.length, 24);
  directory.writeUInt16LE(nameBytes.length, 28);
  directory.writeUInt32LE(offset, 42);
  central.push(directory, nameBytes);
  offset += header.length + nameBytes.length + compressed.length;
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
