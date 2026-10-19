import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSampleBundle } from '../src/samples/bundle.ts';
import { momentaryMax, truePeakDb } from '../src/measure/loudness.ts';
import { readSampleWav } from '../runtime/engine/sample-wav.js';

export function checkFuseFiles(root, site) {
  const read=p=>JSON.parse(readFileSync(resolve(site,p),'utf8'));
  const study=read('media/fuse-session.json'),quality=read('media/fuse-quality.json');
  assert.equal(study.schema,'beeps/fuse-study@1');
  assert.deepEqual(study.cases?.map(c=>c.id),['metal','tommy','m16'],'public Fuse keeps metal, Tommy and M16 comparisons');
  assert.equal(read('media/fuse-tommy-provenance.json').creator,'USC Cinema / Sunset Editorial Collection (CS_USC)','the public row uses the selected archive source');
  assert.deepEqual(study.takes.map(t=>t.id),['recording','procedural','hybrid']);
  assert.equal(quality.reports.length,3);
  assert.deepEqual(study.cases[0].takes,study.takes,'the metal case retains its original three takes');
  const levels=quality.reports.map(r=>r.momentaryMaxLufs);
  assert.ok(Math.max(...levels)-Math.min(...levels)<.2,'three actually measured deliveries match');
  for(const r of quality.reports)assert.ok(Number.isFinite(r.momentaryMaxLufs)&&r.truePeakDb<=-1.5&&!r.lint.errors.length);
  for(const take of study.takes){
    const cue=read(take.cue.replace('./',''));
    assert.equal(cue.id,`fuse-${take.id}`);
    assert.equal(cue.trimDb,quality.reports.find(r=>r.name===cue.id).trimDb);
    assert.deepEqual(cue.patch,read(take.patch.replace('./','')),'cue and inspectable patch agree');
  }
  const source=resolve(root,'library/examples/fuse');
  for(const mode of ['prepared','preparation']){
    const original=readSampleBundle(resolve(source,`${mode}-bundle`));
    for(const patch of original.patches)assert.deepEqual(patch,read(`recipes/${patch.name}.json`),'portable and booth patches agree');
    assert.equal(original.manifest.includePreparation,mode==='preparation');
    assert.equal(Object.keys(original.manifest.samples).length,mode==='preparation'?2:1);
    assert.equal(Object.keys(original.manifest.recipes).length,mode==='preparation'?1:0);
    const directory=mkdtempSync(join(tmpdir(),'beeps-fuse-download-'));
    try {
      const archive=resolve(site,`fuse/fuse-${mode}.tar.gz`);
      const extracted=spawnSync('tar',['-xzf',archive,'-C',directory],{encoding:'utf8',windowsHide:true});
      assert.equal(extracted.status,0,extracted.stderr);
      const relocated=readSampleBundle(resolve(directory,'bundle'));
      assert.deepEqual(relocated.manifest,original.manifest);
      assert.ok(readFileSync(resolve(directory,'README.md'),'utf8').includes('sample sync'));
      assert.ok(readFileSync(resolve(directory,'LICENSE.txt'),'utf8').includes('CC0'));
      assert.equal(JSON.parse(readFileSync(resolve(directory,'provenance.json'),'utf8')).creator,'Kenney');
      for(const [file,bytes]of original.files)assert.deepEqual(readFileSync(resolve(directory,'bundle',file)),bytes);
      const project=resolve(directory,'project');mkdirSync(project);
      const cli=(...args)=>{
        const r=spawnSync(process.execPath,[resolve(root,'scripts/beeps.mjs'),...args],{cwd:project,encoding:'utf8',windowsHide:true});
        assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
      };
      cli('init');cli('sample','sync',resolve(directory,'bundle'));
      assert.ok(!existsSync(resolve(project,'.agent-beeps/samples/originals')),'relocated project has no original recordings');
      if(mode==='preparation'){
        const receipt=JSON.parse(original.files.get(Object.values(original.manifest.recipes)[0].file));
        const object=resolve(project,`.agent-beeps/samples/objects/${receipt.outputId.slice(7)}.wav`);
        unlinkSync(object); // Replay must reconstruct the prepared bytes, not merely find them.
        const replay=cli('sample','prepare','--recipe',resolve(directory,'bundle',Object.values(original.manifest.recipes)[0].file));
        assert.equal(replay.outputId,receipt.outputId);
        assert.deepEqual(readFileSync(object),original.files.get(original.manifest.samples[receipt.outputId].file));
      }
      const rendered=cli('render','fuse-recording','fuse-procedural','fuse-hybrid');
      assert.equal(rendered.renders.length,3);assert.ok(rendered.renders.every(r=>r.ok!==false),'ordinary CLI renders relocated public example');
    } finally {rmSync(directory,{recursive:true,force:true});}
  }
  const provenance=read('fuse/provenance.json');
  assert.equal(provenance.original.sha256,'e07045693e4a2b3d165c424e3dab4c781d9ff8880a386880ac89a51315d7f831');
  for(const p of ['fuse/README.md','fuse/provenance.json'])assert.ok(!/[A-Z]:\\|importedAt|originalPath|candidate-only/.test(readFileSync(resolve(site,p),'utf8')),'no private paths or stale review status');
  const specs=[
    {id:'tommy',sha:'0d382110caed1ede30dd5a198042072978c56243148c4a893f2e81baa1830d20',crop:[0,286792],threshold:-24,groups:[[.06,1.28],[1.46,2.22],[2.46,3.18],[3.62,4.4],[4.6,5.62]]},
    {id:'m16',sha:'612213e122b3efc5122f29ecc78fc4bd6968380ab1c68e38f4225a28878f1161',crop:[0,264304],threshold:-28,groups:[[.04,2.82]]},
  ];
  const allLevels=[...levels],allowedSamples=new Set(['f982ba2f296c7bfebf01c216345e2e6ca98ffd6ee00157de554ea22352b6b1b5']);
  for(const spec of specs){
    const material=study.cases.find(c=>c.id===spec.id),prefix=`fuse-${spec.id}`,quality=read(`media/${prefix}-quality.json`),source=read(`media/${prefix}-provenance.json`);
    assert.equal(source.creator,'USC Cinema / Sunset Editorial Collection (CS_USC)');assert.equal(source.original.sha256,spec.sha);
    assert.equal(source.license,'CC0-1.0');assert.equal(source.sourceEncoding,'Internet Archive original WAV, not a preview transcode');
    assert.ok(source.sourceUrl.startsWith('https://archive.org/details/SSE_Library_GUNS/AUTOMATIC/'));
    assert.ok(readFileSync(resolve(site,`media/${prefix}-license.txt`),'utf8').includes('CC0-1.0'));assert.equal(quality.reports.length,3);
    allLevels.push(...quality.reports.map(r=>r.momentaryMaxLufs));
    const bundle=readSampleBundle(resolve(root,`library/examples/${prefix}/preparation-bundle`));
    assert.equal(Object.keys(bundle.manifest.samples).length,2);assert.equal(Object.keys(bundle.manifest.recipes).length,1);
    const prep=JSON.parse(readFileSync(resolve(root,`library/examples/${prefix}/preparation.json`),'utf8'));
    assert.deepEqual([prep.recipe.startFrame,prep.recipe.endFrame,prep.recipe.fadeInFrames,prep.recipe.fadeOutFrames,prep.recipe.gainDb],[...spec.crop,240,1920,0]);
    assert.equal(prep.recipe.source,source.normalization.asset);assert.equal(prep.channels,1);allowedSamples.add(prep.outputId.slice(7));
    const pcm=readSampleWav(bundle.files.get(bundle.manifest.samples[prep.outputId].file));
    assert.equal(pcm.frames,spec.crop[1]-spec.crop[0]);assert.ok(pcm.channels[0][0]===0);assert.ok(pcm.channels[0].at(-1)===0);
    // Detect high-energy burst groups in the actual delivered dependency, not recipe labels or onset candidates.
    const segments=[];
    for(let i=0;i<pcm.frames;i+=960){let sum=0;for(let j=i;j<Math.min(i+960,pcm.frames);j++)sum+=pcm.channels[0][j]**2;
      const t=i/48000;if(10*Math.log10(sum/960)>spec.threshold){if(segments.length&&t-segments.at(-1)[1]<.1)segments.at(-1)[1]=t+.02;else segments.push([t,t+.02]);}}
    const groups=segments.filter(([s,e])=>e-s>.1);assert.equal(groups.length,spec.groups.length,`${spec.id}: actual recording burst count`);
    for(let i=0;i<groups.length;i++)for(let e=0;e<2;e++)assert.ok(Math.abs(groups[i][e]-spec.groups[i][e])<.12,`${spec.id}: complete group ${i+1} boundary`);
    assert.equal(read(`recipes/${prefix}.json`).burstGroupsSec.length,spec.groups.length);
    for(const take of material.takes){
      const cue=read(take.cue.slice(2)),r=quality.reports.find(r=>r.name===cue.id);
      assert.equal(cue.id,`${prefix}-${take.id}`);assert.equal(cue.trimDb,r.trimDb);assert.deepEqual(cue.patch,read(take.patch.slice(2)));assert.deepEqual(cue.patch,bundle.patches.find(p=>p.name===cue.id));
      assert.equal(cue.patch.layers.length,take.id==='recording'?1:spec.groups.length+(take.id==='hybrid'?1:0));assert.ok(cue.patch.layers.length<=8);
      assert.ok(r.truePeakDb<=-1.5&&!r.lint.errors.length);assert.ok(r.lint.warnings.every(w=>w.rule==='tail-ceiling'),'only intentional long-form tail warnings remain');
      assert.ok(Math.abs(r.momentaryMaxLufs+25.01)<.05);
      for(const [id,asset]of Object.entries(cue.assets??{})){assert.equal(id,prep.outputId);assert.deepEqual(readFileSync(resolve(site,'media',asset.file)),bundle.files.get(bundle.manifest.samples[id].file),'native cue carries the exact prepared archive WAV');}
    }
    for(const p of [`media/${prefix}-provenance.json`,`media/${prefix}-quality.json`,`recipes/${prefix}.json`])assert.ok(!/[A-Z]:\\|importedAt|originalPath|ShawnyBoy|craigsmith|freesound|\.50 caliber|9dea437a980b72dbfc607045279088c5aa585d8353bef7f2d06274a5a282d558/.test(readFileSync(resolve(site,p),'utf8')),'public gun metadata excludes superseded sources/private paths');
  }
  assert.ok(Math.max(...allLevels)-Math.min(...allLevels)<.2,'all three rows share the actual comparison level');
  assert.ok(!existsSync(resolve(root,'library/examples/fuse-heavy')),'pruned indoor source bundle is absent from public examples');
  for(const dir of [resolve(site,'media'),resolve(site,'recipes'),resolve(root,'showcase/media'),resolve(root,'showcase/recipes')])assert.ok(!readdirSync(dir).some(f=>f.startsWith('fuse-heavy')),'pruned indoor media and recipes are absent');
  assert.ok(!readFileSync(resolve(root,'showcase/media/manifest.json'),'utf8').includes('fuse-heavy'),'manifest excludes the removed indoor case');
  for(const file of readdirSync(resolve(site,'media')).filter(f=>/^sample-[a-f0-9]{64}\.wav$/.test(f)))assert.ok(allowedSamples.has(createHash('sha256').update(readFileSync(resolve(site,'media',file))).digest('hex')),'site has no stale or superseded sample bytes');
  return study;
}

export async function testFuse(page, server, study, artifact) {
  await page.waitForFunction(()=>document.querySelectorAll('[data-fuse-take]').length===9);
  const takes=study.cases.flatMap(c=>c.takes.map(t=>({...t,caseId:c.id})));
  for(const take of takes){
    const id=take.caseId==='metal'?take.id:`${take.caseId}-${take.id}`,label={recording:'RECORDING',procedural:'PURE SYNTHESIS',hybrid:'RECORDING + SYNTHESIS'}[take.id];
    const facts=page.locator(`[data-fuse-card="${id}"] .facts`);
    assert.equal(await facts.count(),1,'each Fuse pad has a source label');
    assert.equal(await facts.textContent(),label,'each Fuse pad identifies its source types');
    assert.equal(await facts.isVisible(),true,'Fuse source label is visible');
  }
  const requests=[];page.on('request',r=>{if(/sample-.*\.wav/.test(r.url()))requests.push(r.url());});
  for(const take of takes){
    await page.getByRole('button',{name:`Play Fuse: ${take.title}`,exact:true}).click();
    await page.waitForFunction(title=>document.querySelector('#fuse-status').textContent.includes(`${title} · playing`),take.title);
    assert.equal(await page.locator('.pad.playing').count(),1,'one voice across all studies');
  }
  assert.ok(requests.length>=6,'all three rows request their actual cue sample dependencies');
  await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent==='M16 hybrid · finished. Choose a take to play.');
  assert.equal(await page.locator('.pad.playing').count(),0,'native long-form completion clears its playing state');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.pad.playing').count(),0);
  const signals=await page.evaluate(async()=>{
    const {buildPatch,patchLength}=await import('./engine/patch.js');
    const {loadCueAssets}=await import('./engine/samples.js');
    const {sampleHash}=await import('./engine/sample-hash.js');
    const {buildLimiter}=await import('./engine/fx.js');
    const study=await(await fetch('./media/fuse-session.json')).json(),reports=[],channels=[];
    for(const take of study.cases.flatMap(c=>c.takes.map(t=>({...t,caseId:c.id})))){
      const url=new URL(take.cue,location.href),cue=await(await fetch(url)).json();
      const ctx=new OfflineAudioContext(2,Math.ceil((patchLength(cue.patch)+.05)*48000),48000);
      const samples=await loadCueAssets(ctx,cue,{baseURL:url});
      const safety=buildLimiter(ctx);safety.connect(ctx.destination);
      const v=buildPatch(ctx,cue.patch,{destination:safety,seed:cue.seed,trimDb:cue.trimDb,scale:cue.scale,samples});
      const b=await ctx.startRendering(),left=b.getChannelData(0);let peak=0,energy=0,finite=true;
      for(let c=0;c<2;c++)for(const x of b.getChannelData(c)){peak=Math.max(peak,Math.abs(x));energy+=x*x;finite&&=Number.isFinite(x);}
      reports.push({name:`${take.caseId}-${take.id}`,peak,energy,finite,pcm:[...Array(2)].map((_,i)=>Array.from(b.getChannelData(i)))});channels.push(left.slice());v.dispose();
      // A valid same-shape changed source must change rendered PCM; this proves the sample input matters.
      if(take.id!=='procedural'){
        const control=new OfflineAudioContext(2,b.length,48000),changed=structuredClone(cue);
        const [[oldId,asset]]=Object.entries(cue.assets);
        const bytes=new Uint8Array(await(await fetch(new URL(asset.file,url))).arrayBuffer());
        bytes.fill(0,44); // Same canonical shape and metadata, genuinely different prepared PCM.
        const newId=`sha256:${sampleHash(bytes)}`;
        for(const layer of changed.patch.layers)if(layer.source.type==='sample')layer.source.asset=newId;
        changed.assets={[newId]:asset};
        const silence=await loadCueAssets(control,changed,{baseURL:url,fetcher:async()=>new Response(bytes)});
        if(newId===oldId)throw new Error('changed source hash did not change');
        const safety=buildLimiter(control);safety.connect(control.destination);
        buildPatch(control,changed.patch,{destination:safety,seed:changed.seed,trimDb:changed.trimDb,scale:changed.scale,samples:silence});
        const zero=await control.startRendering();let difference=0,energy=0;
        for(let i=0;i<left.length;i++){difference=Math.max(difference,Math.abs(left[i]-zero.getChannelData(0)[i]));energy+=zero.getChannelData(0)[i]**2;}
        if(difference<.001)throw new Error('recorded-source negative control did not alter PCM');
        if(take.id==='recording'&&energy!==0)throw new Error('recording has a hidden procedural contribution');
        if(take.id==='hybrid'&&energy<=0)throw new Error('hybrid has no procedural contribution');
      }
    }
    for(let offset=0;offset<channels.length;offset+=3)for(let a=offset;a<offset+3;a++)for(let b=a+1;b<offset+3;b++){let difference=0;for(let i=0;i<Math.min(channels[a].length,channels[b].length);i++)difference=Math.max(difference,Math.abs(channels[a][i]-channels[b][i]));if(difference<.001)throw new Error('Fuse takes sound identical');}
    return reports;
  });
  for(const s of signals){
    assert.ok(s.finite&&s.energy>0&&s.peak>.001&&s.peak<1,`${s.name}: healthy native sample/procedural signal`);
    const pcm=s.pcm.map(c=>Float32Array.from(c));delete s.pcm;
    s.momentaryMaxLufs=momentaryMax(pcm,48000);s.truePeakDb=truePeakDb(pcm,48000);
    assert.ok(s.truePeakDb<=-1.5,`${s.name}: actual booth output respects peak ceiling`);
  }
  const actualLevels=signals.map(s=>s.momentaryMaxLufs);
  assert.ok(Math.max(...actualLevels)-Math.min(...actualLevels)<.2,'actual native booth outputs including shared safety are matched');
  // Isolate intentional network failures from the normal page's missing-asset assertion.
  const probe=await page.context().browser().newPage();
  await probe.addInitScript(()=>{
    window.sampleStarts=0;
    const start=AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start=function(...args){window.sampleStarts++;return start.apply(this,args);};
  });
  await probe.goto(`${server.url}/agent-beeps/`);
  await probe.waitForFunction(()=>document.querySelectorAll('[data-fuse-take]').length===9);
  // Delayed real source fetch: Stop and a replacement selection must invalidate obsolete work.
  const samplePattern='**/media/sample-*.wav';let release;
  let loaded;
  const delayed=()=>new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('pending sample request never arrived')),5000);
    loaded=()=>{clearTimeout(timeout);resolve();};
  });
  let arrived=delayed();
  await probe.route(samplePattern,async route=>{await new Promise(r=>{release=r;loaded();});await route.continue().catch(()=>{});});
  await probe.getByRole('button',{name:`Play Fuse: ${study.takes[0].title}`,exact:true}).click();
  await arrived;
  await probe.getByRole('button',{name:'Stop all audio'}).click();release();
  await probe.waitForTimeout(150);assert.equal(await probe.locator('.pad.playing').count(),0,'Stop cancels pending sample');
  assert.equal(await probe.evaluate(()=>window.sampleStarts),0,'Stop creates no obsolete native source');
  arrived=delayed();
  await probe.getByRole('button',{name:`Play Fuse: ${study.takes[0].title}`,exact:true}).click();
  await arrived;
  await probe.getByRole('button',{name:`Play Fuse: ${study.takes[1].title}`,exact:true}).click();
  await probe.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Resonant body · playing'));
  const starts=await probe.evaluate(()=>window.sampleStarts);release();
  await probe.waitForTimeout(150);
  assert.equal(await probe.evaluate(()=>window.sampleStarts),starts,'replacement selection creates no obsolete native source');
  assert.equal(await probe.locator('[data-fuse-card="recording"]').evaluate(el=>el.classList.contains('playing')),false);
  await probe.keyboard.press('Escape');
  for(const [from,to]of [['Tommy recording','Resonant body'],['Recorded detail','Tommy body'],['Tommy recording','M16 body'],['M16 recording','Tommy body'],['Tommy recording','Stop'],['M16 recording','Stop']]){
    arrived=delayed();
    await probe.getByRole('button',{name:`Play Fuse: ${from}`,exact:true}).click();await arrived;
    if(to==='Stop')await probe.getByRole('button',{name:'Stop all audio'}).click();
    else {await probe.getByRole('button',{name:`Play Fuse: ${to}`,exact:true}).click();await probe.waitForFunction(title=>document.querySelector('#fuse-status').textContent.includes(`${title} · playing`),to);}
    const before=await probe.evaluate(()=>window.sampleStarts);release();await probe.waitForTimeout(150);
    assert.equal(await probe.evaluate(()=>window.sampleStarts),before,`${from} -> ${to} cancels the obsolete recorded source across rows`);
    await probe.keyboard.press('Escape');
  }
  for(const control of ['Touch A paused','Touch B paused','Escape','Touch','reel','pad','Flux']){
    arrived=delayed();
    await probe.getByRole('button',{name:`Play Fuse: ${study.takes[0].title}`,exact:true}).click();
    await arrived;
    if(control.startsWith('Touch ')&&control.endsWith(' paused')){
      assert.equal(await probe.locator('#touch-audio').evaluate(a=>a.paused),true,'Touch is paused before selecting its take');
      await probe.getByRole('button',{name:control==='Touch A paused'?'A · Plain':'B · Expressive',exact:true}).click();
      assert.equal(await probe.locator('#touch-audio').evaluate(a=>a.paused),true,'selecting a paused Touch take does not start it');
    }
    if(control==='Escape')await probe.keyboard.press('Escape');
    if(control==='Touch')await probe.locator('#touch-audio').evaluate(a=>a.play());
    if(control==='reel')await probe.locator('#matter-play').click();
    if(control==='pad')await probe.getByRole('button',{name:'Play Crystal switch',exact:true}).click();
    if(control==='Flux')await probe.getByRole('button',{name:'Play Alloy: index envelope',exact:true}).click();
    // Wait until the replacement has started before counting native sources.
    await probe.waitForTimeout(100);
    const before=await probe.evaluate(()=>window.sampleStarts);release();
    await probe.waitForTimeout(150);
    assert.equal(await probe.evaluate(()=>window.sampleStarts),before,`${control} cancels obsolete recorded source`);
    assert.equal(await probe.locator('[data-fuse-card="recording"]').evaluate(el=>el.classList.contains('playing')),false);
    await probe.keyboard.press('Escape');
  }
  await probe.unroute(samplePattern);
  await probe.keyboard.press('Escape');
  let attempts=0;
  await probe.route(samplePattern,async route=>{if(attempts++===0)await route.fulfill({status:503,body:'unavailable'});else await route.continue();});
  await probe.getByRole('button',{name:`Play Fuse: ${study.takes[0].title}`,exact:true}).click();
  await probe.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('retry'));
  await probe.getByRole('button',{name:`Play Fuse: ${study.takes[0].title}`,exact:true}).click();
  await probe.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('playing'));
  await probe.keyboard.press('Escape');await probe.close();
  // Hash every download over HTTP against its committed source.
  for(const mode of ['prepared','preparation']){
    const response=await page.request.get(`${server.url}/agent-beeps/fuse/fuse-${mode}.tar.gz`);
    assert.equal(response.status(),200);
    const hash=b=>createHash('sha256').update(b).digest('hex');
    assert.equal(hash(await response.body()),hash(readFileSync(resolve(artifact,'../../_site/fuse',`fuse-${mode}.tar.gz`))));
  }
  return signals;
}

if(process.argv[1]===import.meta.filename){checkFuseFiles(resolve(import.meta.dirname,'..'),resolve(import.meta.dirname,'../_site'));}
