import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'HANDOFF/SOURCE-MANIFEST.json'),'utf8'));
const failures=[];let sourceFiles=0,checksumFiles=0;
const safe=p=>{const target=path.resolve(root,p);if(!target.startsWith(root+path.sep)||path.isAbsolute(p)||p.split(/[\\/]/).includes('..'))throw Error('Unsafe manifest path');if(fs.existsSync(target)&&(fs.lstatSync(target).isSymbolicLink()||!fs.realpathSync(target).startsWith(root+path.sep)))throw Error('Symlink or real-path escape');return target;};
for(const item of manifest.files){const p=safe(item.path);if(!fs.existsSync(p)||fs.statSync(p).size!==item.size||hash(p)!==item.sha256)failures.push({path:item.path,kind:'source_mismatch'});sourceFiles++;}
for(const line of fs.readFileSync(path.join(root,'HANDOFF/CHECKSUMS.sha256'),'utf8').trim().split(/\r?\n/)){
 const parsed=/^([a-f0-9]{64})  (.+)$/.exec(line);if(!parsed)throw Error('Invalid checksum line');
 const p=safe(parsed[2]);if(!fs.existsSync(p)||hash(p)!==parsed[1])failures.push({path:parsed[2],kind:'checksum_mismatch'});checksumFiles++;
}
console.log(JSON.stringify({status:failures.length?'failed':'passed',sourceFiles,checksumFiles,failures},null,2));
if(failures.length)process.exitCode=1;
