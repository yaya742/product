import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const testRoot = path.join(projectRoot, '.test-data');
export function isolatedEnvironment(label, existing) {
  fs.mkdirSync(testRoot, { recursive: true });
  const dataDir = existing ? path.resolve(existing) : fs.mkdtempSync(path.join(testRoot, label + '-'));
  const relative = path.relative(fs.realpathSync(testRoot), dataDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Tests require a dedicated child directory under .test-data.');
  fs.mkdirSync(dataDir, { recursive: true });
  const actual = path.relative(fs.realpathSync(testRoot), fs.realpathSync(dataDir));
  if (!actual || actual.startsWith('..') || path.isAbsolute(actual))
    throw new Error('Test directory must not resolve outside .test-data.');
  const env = {
    ...process.env,
    ZAICHANG_DATA_DIR: dataDir,
    ZAICHANG_TEST: '1',
    ZAICHANG_TEST_ROOT: testRoot,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ZAICHANG_CONNECTOR_ROOT;
  delete env.ZAICHANG_ZJU_SOURCE;
  return env;
}
