import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const out=resolve(root,'_site');
const manifest=JSON.parse(readFileSync(resolve(root,'showcase/media/manifest.json'),'utf8'));
for(const [path,expected] of Object.entries(manifest.files)){
  const actual=createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex');
  if(actual!==expected)throw new Error(`${path} changed since rendering. Run npm run showcase:render.`);
}
mkdirSync(out,{recursive:true});
for(const file of ['index.html','app.js','style.css'])copyFileSync(resolve(root,'showcase',file),resolve(out,file));
for(const dir of ['media','recipes'])cpSync(resolve(root,'showcase',dir),resolve(out,dir),{recursive:true});
// Publish only the explicit public inventory; extra authoring files are never copied.
for(const path of Object.keys(manifest.files).filter(p=>p.startsWith('library/examples/fuse/'))){
  const target=resolve(out,'fuse',path.slice('library/examples/fuse/'.length));
  mkdirSync(dirname(target),{recursive:true});copyFileSync(resolve(root,path),target);
}
mkdirSync(resolve(out,'booth'),{recursive:true});
for(const file of ['style.css','album.css'])copyFileSync(resolve(root,'runtime/audition',file),resolve(out,'booth',file));
cpSync(resolve(root,'runtime/engine'),resolve(out,'engine'),{recursive:true});
copyFileSync(resolve(root,'LICENSE'),resolve(out,'LICENSE'));
writeFileSync(resolve(out,'.nojekyll'),'');
if(!existsSync(resolve(out,'media/matter.mp3')))throw new Error('Missing reel');
console.log(`Showcase built at ${out}; ${Object.keys(manifest.files).length} source/media hashes verified.`);
