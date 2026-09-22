import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

// Test launch must never silently use an existing personal profile.
export function assertTestDataDirectory() {
  if (process.env.ZAICHANG_TEST !== '1') return;
  const root = process.env.ZAICHANG_TEST_ROOT;
  const target = process.env.ZAICHANG_DATA_DIR;
  if (!root || !target || !existsSync(root)) throw new Error('Isolated test data directory required.');
  const relative = path.relative(realpathSync(root), existsSync(target) ? realpathSync(target) : path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Refusing test launch outside the dedicated test root.');
}
export function assertTestStoreFile(file:string){
  if(process.env.ZAICHANG_TEST!=='1'||file===':memory:')return;
  assertTestDataDirectory();
  const root=realpathSync(process.env.ZAICHANG_TEST_ROOT!),absolute=path.resolve(file),resolved=existsSync(absolute)?realpathSync(absolute):path.join(realpathSync(path.dirname(absolute)),path.basename(absolute));
  const relative=path.relative(root,resolved);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Refusing test database outside the isolated test root.');
}
