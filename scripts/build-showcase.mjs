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
// The playlists page ships beside the booth. Its sealed manifest (node scripts/render-playlists.mjs --seal) must match every file.
const playlists=JSON.parse(readFileSync(resolve(root,'playlists/manifest.json'),'utf8'));
for(const [path,expected] of Object.entries(playlists.files)){
  const actual=createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex');
  if(actual!==expected)throw new Error(`${path} changed since it was sealed. Run node scripts/render-playlists.mjs --seal.`);
}
const tracks=JSON.parse(readFileSync(resolve(root,'playlists/tracks.json'),'utf8'));
for(const set of tracks.sets)for(const t of set.tracks)for(const ref of [t.mp3,t.look,t.recipe]){
  if(!(`playlists/${ref.replace('./','')}` in playlists.files))throw new Error(`${set.id}/${t.id}: ${ref} is not in the playlists manifest`);
}
mkdirSync(resolve(out,'playlists'),{recursive:true});
for(const file of ['index.html','app.js','style.css','tracks.json'])copyFileSync(resolve(root,'playlists',file),resolve(out,'playlists',file));
for(const dir of ['media','songs'])cpSync(resolve(root,'playlists',dir),resolve(out,'playlists',dir),{recursive:true});
writeFileSync(resolve(out,'.nojekyll'),'');
if(!existsSync(resolve(out,'media/matter.mp3')))throw new Error('Missing reel');
console.log(`Showcase built at ${out}; ${Object.keys(manifest.files).length} source/media hashes verified; ${Object.keys(playlists.files).length} playlist files verified.`);
