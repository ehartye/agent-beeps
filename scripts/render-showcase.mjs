// Explicit authoring step. Ordinary site builds only verify and copy these committed results.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { openRenderHost } from '../src/render/host.ts';
import { renderAndMeasure } from '../src/render/pipeline.ts';
import { renderSong } from '../src/render/song-pipeline.ts';
import { loadSong, resolveInstruments } from '../src/music.ts';
import { initProject, parseOrThrow } from '../src/project.ts';
import { lintPatch } from '../src/lint.ts';
import { lintSong } from '../src/song-lint.ts';
import { parseProject } from '../src/schema/project.ts';
import { readWav } from '../src/audio/wav.ts';
import { integrated, truePeakDb } from '../src/measure/loudness.ts';

const root=resolve(import.meta.dirname,'..');
const media=resolve(root,'showcase/media');
const recipes=resolve(root,'showcase/recipes');
mkdirSync(media,{recursive:true});
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const write=(path,obj)=>writeFileSync(path,JSON.stringify(obj,null,2)+'\n');
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const project=initProject(root);
project.project=parseProject(read(resolve(root,'showcase/project.json')));
const presets=[
  ['crystal-switch','Crystal switch','A tiny resonant object. The entire click is a struck modal model.'],
  ['energy-shard','Energy shard','A bright pickup with independently decaying additive overtones.'],
  ['relic-discovered','Relic discovered','An FM discovery chime: a small sound with a long sense of wonder.'],
  ['comet-blaster','Comet blaster','A charged discharge, a throaty energy body and a recoil tail.'],
  ['asteroid-burst','Asteroid burst','A shockwave, secondary cracks and a granular shower of debris.'],
  ['airlock-breath','Airlock breath','Pressure escaping through a pair of shaped noise layers.'],
];
const kit=read(resolve(root,'library/sounds/sci-fi/kit.json'));
const pads=presets.map(([name,title,description])=>({title,description,seed:kit.sounds.find(s=>s.name===name).seed,patch:parseOrThrow(read(resolve(root,`library/sounds/sci-fi/patches/${name}.json`)),name)}));
const growl=read(resolve(root,'library/archetypes/creature-growl.json')).template;
growl.name='subterranean';growl.tags=['gritty'];growl.fx={dcBlock:true};
growl.meta.description='A low creature calling from behind the bulkhead: glottal pulses, jitter and a formant-shaped throat.';
pads.push({title:'Subterranean',description:growl.meta.description,seed:420,patch:parseOrThrow(growl,growl.name)});
const metal={schema:'beeps/patch@1',name:'titanium-rain',family:'foley',tags:['gritty'],duration:1.2,layers:[
  {source:{type:'metal',base:53,bands:[2600,6100]},gainDb:8,amp:{attack:.004,decay:.6,sustain:0,release:.12},filter:{type:'highpass',cutoff:2200}},
  {source:{type:'grains',rate:90,rateEnd:.05,grainDecay:.018,center:4800,q:8,stereo:true},gainDb:-5,amp:{attack:.01,decay:1.1,sustain:0,release:.08}},
],fx:{dcBlock:true,reverb:{preset:'room',sendDb:-18}},meta:{description:'An inharmonic metal strike breaking into a wide scattering of grains.'}};
pads.push({title:'Titanium rain',description:metal.meta.description,seed:1108,patch:parseOrThrow(metal,metal.name)});
const host=await openRenderHost();
try {
  const outcomes=await renderAndMeasure(host,pads.map(p=>({patch:p.patch,seed:p.seed,variant:0})),{project:project.project,rendersDir:project.paths.renders});
  const padReports=[];
  for(let i=0;i<pads.length;i++){
    const result=outcomes[i];if(!result.ok)throw new Error(result.error);
    const p=pads[i];const lint=lintPatch(p.patch,result.features,project.project);
    if(lint.errors.length)throw new Error(`${p.patch.name}: ${JSON.stringify(lint.errors)}`);
    p.trimDb=result.trimDb;p.sources=[...new Set(p.patch.layers.map(l=>l.source.type))];
    p.look=`./media/${p.patch.name}.png`;
    copyFileSync(result.lookPath,resolve(media,`${p.patch.name}.png`));
    write(resolve(recipes,`${p.patch.name}.json`),p.patch);
    padReports.push({name:p.patch.name,seed:p.seed,trimDb:p.trimDb,renderKey:result.key,features:result.features,lint});
  }
  console.log('Eight live pads rendered and linted.');
  const song=loadSong(project,resolve(recipes,'matter.json'));
  const instruments=resolveInstruments(project,song);
  const reel=await renderSong(host,song,instruments,{project:project.project,rendersDir:project.paths.renders});
  const lint=lintSong(song,reel.features,project.project,instruments);
  if(lint.errors.length)throw new Error(`Matter: ${JSON.stringify(lint.errors)}`);
  copyFileSync(reel.lookPath,resolve(media,'matter.png'));
  const ffmpeg=process.env.BEEPS_FFMPEG||ffmpegStatic;
  const encode=spawnSync(ffmpeg,['-y','-hide_banner','-loglevel','error','-i',reel.wavPath,'-c:a','libmp3lame','-q:a','2','-ar','48000','-write_xing','1',resolve(media,'matter.mp3')],{encoding:'utf8'});
  if(encode.status!==0)throw new Error(encode.stderr||'ffmpeg encoding failed; run npm install to install ffmpeg-static or set BEEPS_FFMPEG');
  const decoded=resolve(project.paths.dir,'showcase-decoded.wav');
  const decode=spawnSync(ffmpeg,['-y','-hide_banner','-loglevel','error','-i',resolve(media,'matter.mp3'),'-c:a','pcm_f32le',decoded],{encoding:'utf8'});
  if(decode.status!==0)throw new Error(decode.stderr);
  const wav=readWav(readFileSync(decoded));
  const peak=truePeakDb(wav.channels,wav.sampleRate);
  if(peak> -1)throw new Error(`Encoded true peak ${peak} dBTP exceeds -1 dBTP ceiling`);
  const session={schema:'beeps/showcase@1',title:'Matter',durationSec:wav.channels[0].length/wav.sampleRate,
    loudnessLufs:integrated(wav.channels,wav.sampleRate).lufs,truePeakDb:peak,loudnessRangeLu:reel.features.loudnessRangeLu,
    sections:reel.features.sections,arc:reel.features.arc,scale:project.project.scale,pads};
  write(resolve(media,'session.json'),session);
  write(resolve(media,'quality.json'),{song:{renderKey:reel.key,features:reel.features,lint},pads:padReports,encoded:{integratedLufs:session.loudnessLufs,truePeakDb:peak,durationSec:session.durationSec},project:project.project});
  const {readdirSync}=await import('node:fs');
  const files=['showcase/project.json',...readdirSync(media).filter(f=>f!=='manifest.json').map(f=>`showcase/media/${f}`),...readdirSync(recipes).map(f=>`showcase/recipes/${f}`),...readdirSync(resolve(root,'runtime/engine')).filter(f=>f.endsWith('.js')).map(f=>`runtime/engine/${f}`)];
  write(resolve(media,'manifest.json'),{schema:'beeps/showcase-assets@1',files:Object.fromEntries(files.map(p=>[p,hash(resolve(root,p))]))});
  console.log(JSON.stringify({duration:session.durationSec,lufs:session.loudnessLufs,peak,warnings:lint.warnings,padWarnings:padReports.map(p=>({name:p.name,warnings:p.lint.warnings}))},null,2));
} finally {await host.close();}
