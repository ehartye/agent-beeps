// Render the bundled colony kit (library/sounds/colony-sfx, library/songs/colony-ambient) for the booth.
// The kit is rendered against its own project settings (D major pentatonic, -18 LUFS effects, -20 LUFS music).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { parseOrThrow } from '../src/project.ts';
import { parseProject } from '../src/schema/project.ts';
import { renderAndMeasure } from '../src/render/pipeline.ts';
import { renderSong } from '../src/render/song-pipeline.ts';
import { loadSong, resolveInstruments } from '../src/music.ts';
import { lintPatch } from '../src/lint.ts';
import { lintSong } from '../src/song-lint.ts';
import { readWav } from '../src/audio/wav.ts';
import { integrated, truePeakDb } from '../src/measure/loudness.ts';

const EFFECTS=['till','plant','water','harvest','discovery','door','portal','repair','rest'];
const BEDS=[['glasshouse','Glasshouse'],['canopy','Canopy'],['interior','Interior'],['workshop','Workshop']];
const SONGS=['outpost-dawn','the-underside','window-light'];
// VBR quality for the mp3s, Matter's -q:a 2 for beds and songs alike: the seven tracks total about 5.1 MB, well under the 12 MB budget.
const QUALITY='2';

// Titles and descriptions come from the kit README tables, so the booth says what the kit says.
function readme(root) {
  const text=readFileSync(resolve(root,'library/sounds/colony-sfx/README.md'),'utf8');
  const rows=section=>text.slice(text.indexOf(section)).split('\n').slice(1).filter(l=>l.startsWith('|')).map(l=>l.split('|').slice(1,-1).map(c=>c.trim().replace(/`/g,'')));
  const effects={},beds={};
  for(const cells of rows('## Interaction effects'))if(EFFECTS.includes(cells[0]))effects[cells[0]]={title:cells[1],description:cells[2]};
  for(const cells of rows('## Environmental loops'))if(cells[0].startsWith('ambience-'))beds[cells[0].slice(9)]={description:cells[2]};
  for(const n of EFFECTS)if(!effects[n])throw new Error(`colony README has no row for effect ${n}`);
  for(const [n] of BEDS)if(!beds[n])throw new Error(`colony README has no row for bed ${n}`);
  return {effects,beds};
}

export async function renderColony(host,project) {
  const root=resolve(import.meta.dirname,'..'),media=resolve(root,'showcase/media'),recipes=resolve(root,'showcase/recipes');
  const read=file=>JSON.parse(readFileSync(resolve(root,file),'utf8'));
  const write=(path,obj)=>writeFileSync(path,JSON.stringify(obj,null,2)+'\n');
  const colonyProject=parseProject(read('library/sounds/colony-sfx/project.json'));
  const opts={project:colonyProject,rendersDir:project.paths.renders};
  const text=readme(root);

  // Songs resolve instruments from the project's own patches before the bundled library, so a developer's same-named
  // local patch would change a published render. This project points at a folder that does not exist: library only.
  const libraryOnly={...project,paths:{...project.paths,patches:resolve(project.paths.dir,'colony-library-only')}};
  if(existsSync(libraryOnly.paths.patches))throw new Error(`${libraryOnly.paths.patches} must not exist: colony songs resolve their instruments from the library only`);

  // Effects: seed 1, variant 0, the kit README's export seed. Rendered under the published colony-<id> name, so the
  // look-image label, the downloadable recipe and the live session patch all agree.
  const patches=EFFECTS.map(n=>parseOrThrow({...read(`library/sounds/colony-sfx/effects/${n}.json`),name:`colony-${n}`},n));
  const outcomes=await renderAndMeasure(host,patches.map(patch=>({patch,seed:1,variant:0})),opts);
  const effects=[],effectReports=[];
  for(let i=0;i<EFFECTS.length;i++){
    const id=EFFECTS[i],result=outcomes[i];if(!result.ok)throw new Error(result.error);
    const lint=lintPatch(patches[i],result.features,colonyProject);
    if(lint.errors.length)throw new Error(`colony ${id}: ${JSON.stringify(lint.errors)}`);
    const patch=patches[i];
    copyFileSync(result.lookPath,resolve(media,`colony-${id}.png`));
    write(resolve(recipes,`colony-${id}.json`),patch);
    effects.push({id,...text.effects[id],seed:1,trimDb:result.trimDb,look:`./media/colony-${id}.png`,sources:[...new Set(patch.layers.map(l=>l.source.type))],patch});
    effectReports.push({id,seed:1,trimDb:result.trimDb,renderKey:result.key,features:result.features,lint});
  }

  // Tracks: the song pipeline, then the same mp3 delivery as Matter, decoded back and measured.
  const ffmpeg=process.env.BEEPS_FFMPEG||ffmpegStatic;
  const run=args=>{const r=spawnSync(ffmpeg,['-y','-hide_banner','-loglevel','error',...args],{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr||'ffmpeg failed; run npm install to install ffmpeg-static or set BEEPS_FFMPEG');};
  const tracks=[],trackReports=[];
  const list=[...BEDS.map(([id,title])=>({id,title,kind:'bed',description:text.beds[id].description,file:`library/sounds/colony-sfx/environments/${id}.json`})),
    ...SONGS.map(id=>({id,kind:'song',file:`library/songs/colony-ambient/${id}.json`}))];
  for(const t of list){
    const path=resolve(root,t.file),song=loadSong(libraryOnly,path);
    if(t.kind==='song'){t.title=song.title;t.description=song.description;}
    const instruments=resolveInstruments(libraryOnly,song);
    const render=await renderSong(host,song,instruments,opts);
    const lint=lintSong(song,render.features,colonyProject,instruments);
    if(lint.errors.length)throw new Error(`colony ${t.id}: ${JSON.stringify(lint.errors)}`);
    copyFileSync(render.lookPath,resolve(media,`colony-${t.id}.png`));
    copyFileSync(path,resolve(recipes,`colony-${t.id}.json`));
    const encoded=resolve(media,`colony-${t.id}.mp3`),decoded=resolve(project.paths.dir,`colony-${t.id}-decoded.wav`);
    run(['-i',render.wavPath,'-c:a','libmp3lame','-q:a',QUALITY,'-ar','48000','-write_xing','1',encoded]);
    run(['-i',encoded,'-c:a','pcm_f32le',decoded]);
    const wav=readWav(readFileSync(decoded));
    const lufs=integrated(wav.channels,wav.sampleRate).lufs,peak=truePeakDb(wav.channels,wav.sampleRate),durationSec=wav.channels[0].length/wav.sampleRate;
    if(!Number.isFinite(peak)||peak> -1)throw new Error(`colony ${t.id}: encoded peak ${peak} dBTP is not finite or exceeds -1 dBTP`);
    if(!Number.isFinite(lufs)||Math.abs(lufs-colonyProject.musicLoudness)>1)throw new Error(`colony ${t.id}: encoded loudness ${lufs} LUFS is not within 1 LU of the kit music loudness ${colonyProject.musicLoudness}`);
    tracks.push({id:t.id,title:t.title,kind:t.kind,description:t.description,mp3:`./media/colony-${t.id}.mp3`,durationSec,loudnessLufs:lufs,truePeakDb:peak,look:`./media/colony-${t.id}.png`,recipe:`./recipes/colony-${t.id}.json`});
    trackReports.push({id:t.id,renderKey:render.key,features:render.features,lint,encoded:{integratedLufs:lufs,truePeakDb:peak,durationSec}});
  }
  write(resolve(media,'colony-session.json'),{schema:'beeps/colony-kit@1',scale:colonyProject.scale,effects,tracks});
  write(resolve(media,'colony-quality.json'),{schema:'beeps/colony-quality@1',project:colonyProject,effects:effectReports,tracks:trackReports});
  console.log(JSON.stringify({study:'Colony',effects:effectReports.map(r=>({id:r.id,trimDb:r.trimDb,warnings:r.lint.warnings})),tracks:trackReports.map(r=>({id:r.id,...r.encoded,warnings:r.lint.warnings}))},null,2));
}
