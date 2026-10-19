// Render the two Touch takes at matched integrated loudness and verify the encoded delivery.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { loadSong, resolveInstruments } from '../src/music.ts';
import { renderSong } from '../src/render/song-pipeline.ts';
import { readWav } from '../src/audio/wav.ts';
import { integrated, truePeakDb } from '../src/measure/loudness.ts';
import { lintSong } from '../src/song-lint.ts';

export async function renderExpression(host, project) {
  const root=resolve(import.meta.dirname,'..'), media=resolve(root,'showcase/media');
  const ffmpeg=process.env.BEEPS_FFMPEG||ffmpegStatic;
  const run=args=>{const r=spawnSync(ffmpeg,['-y','-hide_banner','-loglevel','error',...args],{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr||'ffmpeg failed');};
  const reports=[];
  // Find a common attainable level. Level differences should not win an expression comparison.
  const takes=[];
  for(const name of ['touch-plain','touch']) {
    const song=loadSong(project,resolve(root,`showcase/recipes/${name}.json`));
    const instruments=resolveInstruments(project,song);
    const render=await renderSong(host,song,instruments,{project:project.project,rendersDir:project.paths.renders});
    takes.push({name,song,instruments,render});
  }
  const target=Math.min(-21,...takes.map(t=>t.render.features.delivered.integratedLufs));
  for(const take of takes) {
    const trimDb=take.render.trimDb+target-take.render.features.delivered.integratedLufs;
    const render=await renderSong(host,take.song,take.instruments,{project:project.project,rendersDir:project.paths.renders,trimDb});
    const lint=lintSong(take.song,render.features,project.project,take.instruments);
    if(lint.errors.length)throw new Error(`${take.name}: ${JSON.stringify(lint.errors)}`);
    copyFileSync(render.lookPath,resolve(media,`${take.name}.png`));
    const encoded=resolve(media,`${take.name}.mp3`),decoded=resolve(project.paths.dir,`${take.name}-decoded.wav`);
    run(['-i',render.wavPath,'-c:a','libmp3lame','-q:a','2','-ar','48000','-write_xing','1',encoded]);
    run(['-i',encoded,'-c:a','pcm_f32le',decoded]);
    const wav=readWav(readFileSync(decoded));
    const lufs=integrated(wav.channels,wav.sampleRate).lufs,peak=truePeakDb(wav.channels,wav.sampleRate);
    if(peak> -1)throw new Error(`${take.name}: encoded peak ${peak} exceeds -1 dBTP`);
    reports.push({name:take.name,renderKey:render.key,features:render.features,lint,encoded:{integratedLufs:lufs,truePeakDb:peak,durationSec:wav.channels[0].length/wav.sampleRate}});
  }
  if(Math.abs(reports[0].encoded.integratedLufs-reports[1].encoded.integratedLufs)>.2)throw new Error('Encoded A/B loudness differs by more than 0.2 LU');
  writeFileSync(resolve(media,'touch-quality.json'),JSON.stringify({schema:'beeps/expression-study@1',bpm:92,bars:8,takes:reports},null,2)+'\n');
  console.log(JSON.stringify({study:'Touch',takes:reports.map(r=>({name:r.name,...r.encoded,warnings:r.lint.warnings}))},null,2));
}
