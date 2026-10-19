// Controlled SFX pairs: only the modulator's normalized index envelope changes the synthesis.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const amp=(attack,decay,sustain,release)=>({attack,decay,sustain,release});
const cases=[
  {id:'alloy',title:'Alloy',seed:73,description:'A bright, inharmonic strike settles into a softer ringing body.',
    patch:{duration:.85,layers:[
      {source:{type:'fm',pitch:'C4',operators:[{ratio:1,index:1},{ratio:2.76,index:3.2,indexEnv:[[0,1],[.025,.55,'exp'],[.16,.08,'exp'],[.65,.006,'exp'],[.85,0]]}],algorithm:[[1,0]]},gainDb:-7,amp:amp(.005,.45,0,.2),highpass:80},
      {source:{type:'osc',wave:'sine',pitch:'C3'},gainDb:-20,amp:amp(.008,.12,0,.1),highpass:40},
    ],fx:{dcBlock:true,reverb:{preset:'room',sendDb:-22}}}},
  {id:'arc',title:'Arc',seed:307,description:'A short discharge flares, folds inward, then spits one last bright edge.',
    patch:{duration:.7,layers:[
      {source:{type:'fm',pitch:'C3',operators:[{ratio:1,index:1},{ratio:1.414,index:5,indexEnv:[[0,.08],[.012,1],[.075,.12,'exp'],[.16,.7],[.5,.008,'exp'],[.7,0]]},{ratio:3.97,index:.8}],algorithm:[[2,1],[1,0]]},gainDb:-8,amp:amp(.006,.3,.12,.13),highpass:70},
      {source:{type:'noise',color:'white'},gainDb:-28,amp:amp(.004,.025,0,.02),filter:{type:'highpass',cutoff:2000,resonanceDb:0}},
    ],fx:{dcBlock:true}}},
  {id:'pulse-core',title:'Pulse core',seed:1109,description:'A low machine tone turns through discrete changes of harmonic pressure.',
    patch:{duration:1.6,layers:[
      {source:{type:'fm',pitch:'C2',operators:[{ratio:1,index:1},{ratio:3.03,index:5.5,indexEnv:[[0,.08],[.1,.8],[.24,.12,'exp'],[.4,.65,'step'],[.55,.12,'exp'],[.75,1,'step'],[.9,.14,'exp'],[1.1,.6,'step'],[1.45,.02,'exp'],[1.6,0]]}],algorithm:[[1,0]]},gainDb:-9,amp:amp(.012,0,.75,.14),highpass:40},
    ],fx:{dcBlock:true}}},
];
const studies=cases.map(c=>{
  const shaped={schema:'beeps/patch@1',name:`flux-${c.id}-shaped`,family:'foley',tags:['study','gritty'],...c.patch,
    meta:{description:`${c.title}: modulator index follows a breakpoint envelope.`}};
  const fixed=structuredClone(shaped);fixed.name=`flux-${c.id}-static`;fixed.meta.description=`${c.title}: modulator index stays at its peak.`;
  for(const l of fixed.layers)if(l.source.type==='fm')for(const op of l.source.operators)delete op.indexEnv;
  for(const patch of [fixed,shaped])for(const dir of ['showcase/recipes','library/sounds/flux/patches']){
    mkdirSync(resolve(root,dir),{recursive:true});writeFileSync(resolve(root,dir,`${patch.name}.json`),JSON.stringify(patch,null,2)+'\n');
  }
  return {id:c.id,title:c.title,seed:c.seed,description:c.description,static:fixed.name,shaped:shaped.name};
});
writeFileSync(resolve(root,'showcase/recipes/flux.json'),JSON.stringify({schema:'beeps/flux-study@1',cases:studies},null,2)+'\n');
console.log('Flux: three static/enveloped FM pairs.');
