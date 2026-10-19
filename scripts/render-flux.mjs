import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOrThrow } from '../src/project.ts';
import { renderAndMeasure } from '../src/render/pipeline.ts';
import { lintPatch } from '../src/lint.ts';
import { momentaryMax, samplePeakDb, truePeakDb } from '../src/measure/loudness.ts';
import { clippedSamples } from '../src/measure/envelope.ts';

export async function renderFlux(host,project) {
  const root=resolve(import.meta.dirname,'..'),media=resolve(root,'showcase/media');
  const read=file=>JSON.parse(readFileSync(resolve(root,file),'utf8'));
  const plan=read('showcase/recipes/flux.json'),reports=[],cases=[];
  for(const c of plan.cases){
    const patches=['static','shaped'].map(take=>parseOrThrow(read(`showcase/recipes/${c[take]}.json`),c[take]));
    const renders=await renderAndMeasure(host,patches.map(patch=>({patch,seed:c.seed,variant:0})),{project:project.project,rendersDir:project.paths.renders});
    for(const r of renders)if(!r.ok)throw new Error(r.error);
    const target=Math.min(-22,...renders.map(r=>r.features.delivered.momentaryMaxLufs));
    const items=patches.map((patch,i)=>({patch,opts:{seed:c.seed,variant:0,scale:project.project.scale,trimDb:renders[i].trimDb+target-renders[i].features.delivered.momentaryMaxLufs}}));
    const signals=await host.render(items),takes={};
    for(let i=0;i<2;i++){
      const r=renders[i],signal=signals[i],take=i?'shaped':'static';
      if(!signal.ok)throw new Error(signal.error);
      const loud=momentaryMax(signal.delivered,signal.sampleRate),peak=truePeakDb(signal.delivered,signal.sampleRate);
      if(!Number.isFinite(loud)||peak> -1)throw new Error(`${r.patch.name}: invalid delivered signal ${loud} LUFS, ${peak} dBTP`);
      const features={...r.features,delivered:{samplePeakDb:samplePeakDb(signal.delivered),truePeakDb:peak,momentaryMaxLufs:loud,clippedSamples:clippedSamples(signal.delivered)}};
      // These foley studies share an explicit comparison target, separate from the booth's default.
      const lint=lintPatch(r.patch,features,{...project.project,targetLoudness:target});
      if(lint.errors.length)throw new Error(`${r.patch.name}: ${JSON.stringify(lint.errors)}`);
      const mono=new Float32Array(signal.authored[0].length);
      for(const ch of signal.authored)for(let n=0;n<mono.length;n++)mono[n]+=ch[n]/signal.authored.length;
      const [look]=await host.looks([{mono,sampleRate:signal.sampleRate,features,label:r.patch.name}]);
      writeFileSync(resolve(media,`${r.patch.name}.png`),look);
      takes[take]={title:c.title,patch:r.patch,seed:c.seed,trimDb:items[i].opts.trimDb,look:`./media/${r.patch.name}.png`};
      reports.push({name:r.patch.name,renderKey:r.key,trimDb:items[i].opts.trimDb,loudnessTargetLufs:target,momentaryMaxLufs:loud,truePeakDb:peak,features,lint});
    }
    const pair=reports.slice(-2);
    if(Math.abs(pair[0].momentaryMaxLufs-pair[1].momentaryMaxLufs)>.2)throw new Error(`${c.id}: loudness mismatch`);
    cases.push({id:c.id,title:c.title,description:c.description,takes});
  }
  writeFileSync(resolve(media,'flux-session.json'),JSON.stringify({schema:'beeps/flux-study@1',cases,scale:project.project.scale},null,2)+'\n');
  writeFileSync(resolve(media,'flux-quality.json'),JSON.stringify({schema:'beeps/flux-quality@1',reports},null,2)+'\n');
  console.log(JSON.stringify({study:'Flux',signals:reports.map(r=>({name:r.name,momentaryMaxLufs:r.momentaryMaxLufs,truePeakDb:r.truePeakDb,warnings:r.lint.warnings}))},null,2));
}
