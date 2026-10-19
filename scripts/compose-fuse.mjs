// A small recorded/procedural material study; no external authoring software is required.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initProject, parseOrThrow, savePatch } from '../src/project.ts';
import { prepareSample } from '../src/samples/prepare.ts';
import { bundleSamples, syncSampleBundle } from '../src/samples/bundle.ts';

const root=resolve(import.meta.dirname,'..'),source=resolve(root,'library/examples/fuse');
const project=initProject(root);
if(existsSync(resolve(source,'preparation-bundle')))syncSampleBundle(project,resolve(source,'preparation-bundle'));
const recipe={schema:'beeps/sample-prep@1',source:'sha256:142e6ff80425adde0e210abbe49b42a532b5d88a89ad6198265a6ed5d3bd7383',startFrame:0,endFrame:7909,fadeInFrames:96,fadeOutFrames:960,gainDb:-3};
const prepared=prepareSample(project,recipe);
const amp=(attack,decay,sustain,release)=>({attack,decay,sustain,release});
const recording={source:{type:'sample',asset:prepared.outputId},gainDb:-5,amp:amp(0,0,1,0)};
// Leave the first few milliseconds to the recording. A dark inharmonic body opens under it,
// a falling FM resonance moves through that body, and sparse grains carry it into the room.
const body=[
  {source:{type:'modal',pitch:'C3',modes:[[1,95,0],[2.76,70,-9],[5.4,48,-16]],exciter:'noiseBurst'},start:.012,gainDb:3,amp:amp(.006,.8,0,.12),highpass:65},
  {source:{type:'fm',pitch:'C2',operators:[{ratio:1,index:1},{ratio:1.414,index:2.4,indexEnv:[[0,.85],[.045,.35,'exp'],[.22,.04,'exp'],[.8,.004,'exp'],[1.1,0]]}],algorithm:[[1,0]]},start:.024,gainDb:-18,amp:amp(.012,.62,0,.16),highpass:55},
  {source:{type:'grains',rate:52,rateEnd:.2,grainDecay:.024,center:2800,q:5,stereo:true},start:.05,gainDb:-23,amp:amp(.012,.85,0,.12),filter:{type:'lowpass',cutoff:5500}},
];
const takes=[
  {id:'recording',title:'Recorded detail',description:'A prepared metal strike: the hard contact, small scrapes and irregular attack.',patch:{duration:.32,layers:[{...recording,gainDb:0}],fx:{dcBlock:true}}},
  {id:'procedural',title:'Resonant body',description:'An inharmonic body, a folding FM resonance and a thinning stereo grain trail.',patch:{duration:1.1,layers:body,fx:{dcBlock:true,reverb:{preset:'room',sendDb:-19}}}},
  {id:'hybrid',title:'Fused strike',description:'Recorded contact locks onto the designed body; the short hit becomes a heavy, moving object.',patch:{duration:1.1,layers:[recording,...body],fx:{dcBlock:true,reverb:{preset:'room',sendDb:-19}}}},
];
mkdirSync(source,{recursive:true});
for(const take of takes){
  const patch=parseOrThrow({schema:'beeps/patch@1',name:`fuse-${take.id}`,family:'foley',tags:['study','gritty'],...take.patch,meta:{intent:take.id==='recording'?'click':'oneshot',description:take.description}},`fuse-${take.id}`);
  savePatch(project,patch,{force:true});
  writeFileSync(resolve(root,`showcase/recipes/${patch.name}.json`),JSON.stringify(patch,null,2)+'\n');
  take.patch=patch.name;
}
writeFileSync(resolve(root,'showcase/recipes/fuse.json'),JSON.stringify({schema:'beeps/fuse-study@1',seed:607,takes},null,2)+'\n');
writeFileSync(resolve(root,'showcase/recipes/fuse-preparation.json'),JSON.stringify(prepared.receipt,null,2)+'\n');
for(const mode of ['prepared','preparation'])bundleSamples(project,takes.map(t=>t.patch),resolve(source,`${mode}-bundle`),{includePreparation:mode==='preparation'});
console.log('Fuse: prepared recording, procedural body and hybrid; portable sources and exact preparation replay.');
