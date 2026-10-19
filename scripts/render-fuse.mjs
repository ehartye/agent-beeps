import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseOrThrow } from '../src/project.ts';
import { renderAndMeasure } from '../src/render/pipeline.ts';
import { lintPatch } from '../src/lint.ts';
import { momentaryMax, samplePeakDb, truePeakDb } from '../src/measure/loudness.ts';
import { clippedSamples } from '../src/measure/envelope.ts';
import { makeCue } from '../src/runtime/cue.ts';
import { cueSources, writeCueDelivery } from '../src/runtime/delivery.ts';
import { samplePaths } from '../src/samples/store.ts';
import { syncSampleBundle } from '../src/samples/bundle.ts';
import { resolveSampleWavs } from '../src/samples/transport.ts';
import { createTar } from '../src/build/tar.ts';

export async function renderFuse(host,project){
  const root=resolve(import.meta.dirname,'..'),media=resolve(root,'showcase/media'),source=resolve(root,'library/examples/fuse');
  const read=p=>JSON.parse(readFileSync(resolve(root,p),'utf8'));
  syncSampleBundle(project,resolve(source,'preparation-bundle'));
  const objects=samplePaths(project).objects,plan=read('showcase/recipes/fuse.json');
  const patches=plan.takes.map(t=>parseOrThrow(read(`showcase/recipes/${t.patch}.json`),t.patch));
  const results=await renderAndMeasure(host,patches.map(patch=>({patch,seed:plan.seed,variant:0})),{project:project.project,rendersDir:project.paths.renders,sampleObjectsDir:objects});
  for(const r of results)if(!r.ok)throw new Error(r.error);
  const target=Math.min(-24,...results.map(r=>r.features.delivered.momentaryMaxLufs));
  const items=patches.map((patch,i)=>({patch,opts:{seed:plan.seed,variant:0,scale:project.project.scale,sampleWavs:resolveSampleWavs(patch,objects),trimDb:results[i].trimDb}}));
  // The output safety curve is nonlinear: iteratively measure the real delivered PCM.
  // A trim estimate alone does not establish that the listener gets equal loudness.
  let signals;
  for(let pass=0;pass<8;pass++){
    signals=await host.render(items);
    let matched=true;
    for(let i=0;i<signals.length;i++){
      const signal=signals[i];if(!signal.ok)throw new Error(signal.error);
      const error=target-momentaryMax(signal.delivered,signal.sampleRate);
      if(Math.abs(error)>.025){items[i].opts.trimDb+=error;matched=false;}
    }
    if(matched)break;
    if(pass===7)throw new Error('Fuse: delivered loudness did not converge');
  }
  const reports=[],takes=[];
  for(let i=0;i<patches.length;i++){
    const patch=patches[i],signal=signals[i],r=results[i],take=plan.takes[i];
    const loud=momentaryMax(signal.delivered,signal.sampleRate),peak=truePeakDb(signal.delivered,signal.sampleRate);
    if(!Number.isFinite(loud)||peak> -1.5)throw new Error(`${patch.name}: invalid comparison delivery ${loud} LUFS / ${peak} dBTP`);
    const features={...r.features,delivered:{samplePeakDb:samplePeakDb(signal.delivered),truePeakDb:peak,momentaryMaxLufs:loud,clippedSamples:clippedSamples(signal.delivered)}};
    const lint=lintPatch(patch,features,{...project.project,targetLoudness:target});
    if(lint.errors.length)throw new Error(`${patch.name}: ${JSON.stringify(lint.errors)}`);
    const mono=new Float32Array(signal.authored[0].length);
    for(const ch of signal.authored)for(let n=0;n<mono.length;n++)mono[n]+=ch[n]/signal.authored.length;
    const [look]=await host.looks([{mono,sampleRate:signal.sampleRate,features,label:patch.name}]);
    writeFileSync(resolve(media,`${patch.name}.png`),look);
    const sources=cueSources(patch,patch.name,objects),cue=makeCue(patch,project.project,plan.seed,items[i].opts.trimDb,sources.assets);
    writeCueDelivery(media,cue,sources,{cleanPrevious:true});
    takes.push({id:take.id,title:take.title,description:take.description,cue:`./media/${patch.name}.runtime.json`,look:`./media/${patch.name}.png`,patch:`./recipes/${patch.name}.json`});
    reports.push({name:patch.name,renderKey:r.key,seed:plan.seed,trimDb:items[i].opts.trimDb,loudnessTargetLufs:target,momentaryMaxLufs:loud,truePeakDb:peak,features,lint});
  }
  const levels=reports.map(r=>r.momentaryMaxLufs);
  if(Math.max(...levels)-Math.min(...levels)>.2)throw new Error('Fuse: delivered loudness mismatch');
  writeFileSync(resolve(media,'fuse-session.json'),JSON.stringify({schema:'beeps/fuse-study@1',takes},null,2)+'\n');
  writeFileSync(resolve(media,'fuse-quality.json'),JSON.stringify({schema:'beeps/fuse-quality@1',comparison:'Individually leveled max-momentary comparisons; relative layer balance in the hybrid differs from solo playback.',ownerListening:'pending',reports},null,2)+'\n');
  // Existing deterministic ustar writer + gzip: no file timestamps or machine paths.
  for(const mode of ['prepared','preparation']){
    const dir=resolve(source,`${mode}-bundle`),entries=[];
    for(const file of readdirSync(dir,{recursive:true}).sort()){
      if(file.endsWith('.json')||file.endsWith('.wav'))entries.push({name:`bundle/${file.replaceAll('\\','/')}`,data:readFileSync(resolve(dir,file))});
    }
    for(const file of ['README.md','LICENSE.txt','provenance.json'])entries.push({name:file,data:readFileSync(resolve(source,file))});
    writeFileSync(resolve(source,`fuse-${mode}.tar.gz`),gzipSync(createTar(entries),{level:9}));
  }
  console.log(JSON.stringify({study:'Fuse',signals:reports.map(r=>({name:r.name,lufs:r.momentaryMaxLufs,truePeakDb:r.truePeakDb,warnings:r.lint.warnings}))},null,2));
}
