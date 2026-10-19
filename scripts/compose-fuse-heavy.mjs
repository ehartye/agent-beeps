// Reproduce the CC0 gun rows from canonical bundles. Source flags are needed only for first import.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { initProject, parseOrThrow, savePatch } from '../src/project.ts';
import { importSample, prepareSample } from '../src/samples/prepare.ts';
import { bundleSamples, syncSampleBundle } from '../src/samples/bundle.ts';
import { gunStudies, archiveMember, archiveURL } from './fuse-gun-studies.mjs';

const root=resolve(import.meta.dirname,'..'),project=initProject(root);
const amp=(attack,decay,sustain,release)=>({attack,decay,sustain,release});
for(const study of gunStudies){
  const source=resolve(root,`library/examples/fuse-${study.id}`);
  if(existsSync(resolve(source,'preparation-bundle')))syncSampleBundle(project,resolve(source,'preparation-bundle'));
  const input=process.argv.indexOf(study.sourceFlag);let imported;
  if(input>=0){
    const file=resolve(process.argv[input+1]);
    if(createHash('sha256').update(readFileSync(file)).digest('hex')!==study.sha256)throw new Error(`Expected the exact original archive WAV for ${study.title}.`);
    imported=importSample(project,file,{origin:archiveURL(study),license:'CC0-1.0'});
  }
  const saved=existsSync(resolve(source,'preparation.json'))?JSON.parse(readFileSync(resolve(source,'preparation.json'),'utf8')):undefined;
  if(!imported&&!saved)throw new Error(`First authoring run requires ${study.sourceFlag} <original archive WAV>.`);
  const recipe={schema:'beeps/sample-prep@1',source:imported?.normalizedId??saved.recipe.source,startFrame:study.crop[0],endFrame:study.crop[1],fadeInFrames:240,fadeOutFrames:1920,gainDb:0};
  const prepared=prepareSample(project,recipe),duration=(study.crop[1]-study.crop[0])/48000;
  // One pulsing low-noise bed per group. ADSR tapers, while the recording retains exact shots and room.
  const body=study.groups.map(([start,end],i)=>({source:{type:'noise',color:'pink'},start,gainDb:3-[0,.4,.2,.7,.3,.4][i],drive:.25,filter:{type:'bandpass',cutoff:study.cutoff,q:.5},highpass:45,lfo:{target:'gain',rate:20,depth:1},amp:amp(.008,Number(((end-start)*1.15).toFixed(4)),0,.05)}));
  const recording={source:{type:'sample',asset:prepared.outputId},gainDb:0,amp:amp(0,0,1,0)};
  const graphs=[{layers:[recording],fx:{dcBlock:true}},{layers:body,fx:{dcBlock:true,reverb:{preset:'small',sendDb:-24}}},{layers:[recording,...body.map(layer=>({...layer,gainDb:layer.gainDb+study.hybridBodyDb}))],fx:{dcBlock:true,reverb:{preset:'small',sendDb:-24}}}];
  const takes=['recording','procedural','hybrid'].map((id,i)=>({id,title:study.names[i],description:study.descriptions[i],patch:graphs[i]}));
  mkdirSync(source,{recursive:true});
  for(const take of takes){
    const patch=parseOrThrow({schema:'beeps/patch@1',name:`fuse-${study.id}-${take.id}`,family:'foley',tags:['study','gritty','gunshot'],duration,...take.patch,meta:{intent:'oneshot',description:take.description}},take.id);
    savePatch(project,patch,{force:true});writeFileSync(resolve(root,`showcase/recipes/${patch.name}.json`),JSON.stringify(patch,null,2)+'\n');take.patch=patch.name;
  }
  writeFileSync(resolve(root,`showcase/recipes/fuse-${study.id}.json`),JSON.stringify({schema:'beeps/fuse-study@1',seed:607,burstGroupsSec:study.groups,takes},null,2)+'\n');
  writeFileSync(resolve(source,'preparation.json'),JSON.stringify(prepared.receipt,null,2)+'\n');
  bundleSamples(project,takes.map(t=>t.patch),resolve(source,'preparation-bundle'),{includePreparation:true});
  if(imported){
    const provenance={schema:'beeps/public-source@1',title:study.sourceTitle,creator:'USC Cinema / Sunset Editorial Collection (CS_USC)',sourceUrl:archiveURL(study),audioUrl:archiveURL(study,true),archiveItem:'SSE_Library_GUNS',archiveMember:archiveMember(study),sourceEncoding:'Internet Archive original WAV, not a preview transcode',license:'CC0-1.0',licenseUrl:'https://creativecommons.org/publicdomain/zero/1.0/',licenseEvidence:'The Internet Archive item metadata supplies the CC0 license URL; its member SHA1 matches the selected original WAV.',original:{sha256:study.sha256,sha1:study.sha1,bytes:study.bytes},normalization:{sampleRate:48000,sourceSampleRate:imported.receipt.sourceSampleRate,channels:imported.channels,frames:imported.frames,asset:imported.normalizedId,decoder:imported.receipt.decoder},history:'The archive item describes sound effects from USC Cinema and/or the Sunset Editorial Collection. The original archive member title is retained.',derivative:`${study.groups.length} recorded burst group${study.groups.length===1?'':'s'}, ${duration.toFixed(4)} seconds, with native shots, gaps and room tails. Preparation uses source frames ${study.crop[0]}–${study.crop[1]}, a 240-frame fade in, 1920-frame fade out and unity gain. A DC blocker removes offset. Pulsing low noise supplies designed weight, not an exact shot reconstruction. Runtime cues use separately measured listening trims.`,scope:'CC0 recording and preparation derivatives. No unlisted firearm model or caliber, modern field-recording provenance, creator endorsement or owner listening approval is claimed.'};
    writeFileSync(resolve(source,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');
  }
  writeFileSync(resolve(source,'LICENSE.txt'),`${study.sourceTitle} — USC Cinema / Sunset Editorial Collection (CS_USC)\n${archiveURL(study)}\n\nThe Internet Archive item metadata provides Creative Commons 0 (CC0-1.0):\nhttps://creativecommons.org/publicdomain/zero/1.0/\nhttps://creativecommons.org/publicdomain/zero/1.0/legalcode\n\nThis example uses the original archive WAV. Its normalized and prepared derivatives,\nprocedural example patches and preparation recipe are also provided under CC0-1.0.\nNo endorsement is implied.\n`);
  writeFileSync(resolve(source,'README.md'),`# ${study.title}\n\nSource: **${study.sourceTitle}**, original WAV from the [SSE Library: GUNS](${archiveURL(study)}).\nThe archive credits USC Cinema and/or the Sunset Editorial Collection and declares CC0.\nThe file is not a preview transcode. Its original archive member name is preserved in provenance.\n\n${study.caseDescription}\n\nThe ${duration.toFixed(4)}-second preparation crops original frames ${study.crop[0]}–${study.crop[1]},\nwith a 5 ms fade in, 40 ms fade out and unity gain. Mono is preserved.\n${study.id==='heavy'?'The seventh burst starts after this excerpt; six complete groups are kept.':'The complete original sequence and its natural room tail are retained.'}\n\nEach procedural group is a low noise bed with a fading ADSR envelope and 20 Hz tremolo.\nThis designed weight does not reconstruct individual shots. The recording preserves its cadence\nand room. Takes are independently matched in measured max-momentary loudness; solos are comparisons,\nnot stems. Generic foley tail-ceiling warnings are retained because these are intentional long\nrecorded sequences rather than single short impacts.\n\nThe strict preparation-bundle contains canonical source, prepared audio, three patches and exact\npreparation receipt, with no original file, private path or import receipt. In an initialized project:\n\n\x60\x60\x60sh\nbeeps sample sync /path/to/fuse-${study.id}/preparation-bundle\nbeeps render fuse-${study.id}-recording fuse-${study.id}-procedural fuse-${study.id}-hybrid\n\x60\x60\x60\n\nFrom this repository, node scripts/compose-fuse-heavy.mjs replays every gun bundle without originals.\nThe ordinary showcase render/build path publishes the listening studies. Existing metal packs\ndemonstrate the downloadable preparation workflow; no separate gun download archive is needed.\n`);
  console.log(`Fuse ${study.id}: ${study.groups.length} recorded burst group(s), ${duration.toFixed(4)}s; canonical preparation replay retained.`);
}
