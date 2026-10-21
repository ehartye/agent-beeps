import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveShowcase } from './showcase-server.mjs';
import { parsePatch } from '../src/schema/patch.ts';
import { songOrThrow } from '../src/music.ts';
import { checkFuseFiles, testFuse } from './test-fuse.mjs';
import { testTransport } from './test-showcase-transport.mjs';

const root=resolve(import.meta.dirname,'..');
const site=resolve(root,'_site');
const artifact=resolve(root,'.agent-beeps/showcase-review');mkdirSync(artifact,{recursive:true});
const session=JSON.parse(readFileSync(resolve(site,'media/session.json'),'utf8'));
assert.equal(session.pads.length,8);
assert.equal(session.sections.length,9);
assert.ok(Number.isFinite(session.loudnessLufs));
assert.ok(session.truePeakDb<=-1,'encoded audio peak ceiling');
assert.ok(session.durationSec>=90 && session.durationSec<100);
for(const p of session.pads)assert.ok(parsePatch(p.patch).ok,`${p.title}: parsed patch`);
songOrThrow(JSON.parse(readFileSync(resolve(site,'recipes/matter.json'),'utf8')),'matter');
const study=JSON.parse(readFileSync(resolve(site,'media/touch-quality.json'),'utf8'));
const flux=JSON.parse(readFileSync(resolve(site,'media/flux-session.json'),'utf8'));
const fluxQuality=JSON.parse(readFileSync(resolve(site,'media/flux-quality.json'),'utf8'));
const fuse=checkFuseFiles(root,site);
// Colony: the kit's own session, recipes and measurements, checked against the library it was rendered from.
const colony=JSON.parse(readFileSync(resolve(site,'media/colony-session.json'),'utf8'));
const colonyQuality=JSON.parse(readFileSync(resolve(site,'media/colony-quality.json'),'utf8'));
const colonyProject=JSON.parse(readFileSync(resolve(root,'library/sounds/colony-sfx/project.json'),'utf8'));
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
assert.equal(colony.schema,'beeps/colony-kit@1');
assert.ok(colony.scale&&colony.scale.root,'colony session carries the kit scale');
assert.equal(colony.effects.length,9);assert.equal(colony.tracks.length,7);
assert.equal(colony.tracks.filter(t=>t.kind==='bed').length,4);assert.equal(colony.tracks.filter(t=>t.kind==='song').length,3);
for(const e of colony.effects){
  assert.ok(parsePatch(e.patch).ok,`${e.id}: parsed colony patch`);
  // The render publishes the schema-normalized patch (defaults filled in) under the renamed colony-<id> name.
  const library=readJson(resolve(root,`library/sounds/colony-sfx/effects/${e.id}.json`));library.name=`colony-${e.id}`;
  const parsed=parsePatch(library);assert.ok(parsed.ok,`${e.id}: library effect parses`);
  const published=readJson(resolve(site,`recipes/colony-${e.id}.json`));
  assert.deepEqual(published,parsed.patch,`${e.id}: library and downloadable Colony effect recipe agree (renamed)`);
  assert.deepEqual(e.patch,published,`${e.id}: the live session patch is the downloadable recipe`);
}
for(const t of colony.tracks){
  const file=t.kind==='bed'?`library/sounds/colony-sfx/environments/${t.id}.json`:`library/songs/colony-ambient/${t.id}.json`;
  const published=readJson(resolve(site,`recipes/colony-${t.id}.json`));
  songOrThrow(published,t.id);
  assert.deepEqual(published,readJson(resolve(root,file)),`${t.id}: library and downloadable Colony ${t.kind} recipe agree`);
  assert.ok(Number.isFinite(t.durationSec)&&t.durationSec>0,`${t.id}: finite duration`);
  assert.ok(t.truePeakDb<=-1,`${t.id}: encoded true peak ceiling`);
  assert.ok(Math.abs(t.loudnessLufs-colonyProject.musicLoudness)<=1,`${t.id}: within 1 LU of the kit music loudness`);
}
for(const path of [...colony.effects.map(e=>e.look),...colony.tracks.flatMap(t=>[t.look,t.mp3,t.recipe])])assert.ok(existsSync(resolve(site,path)),`${path}: published file exists`);
assert.equal(colonyQuality.effects.length,9);assert.equal(colonyQuality.tracks.length,7);
for(const r of [...colonyQuality.effects,...colonyQuality.tracks])assert.deepEqual(r.lint.errors,[],`${r.id}: no colony lint errors`);
assert.equal(flux.cases.length,3);assert.equal(fluxQuality.reports.length,6);
for(const c of flux.cases){
  for(const take of Object.values(c.takes)){
    assert.ok(parsePatch(take.patch).ok);
    assert.deepEqual(JSON.parse(readFileSync(resolve(root,`library/sounds/flux/patches/${take.patch.name}.json`),'utf8')),JSON.parse(readFileSync(resolve(site,`recipes/${take.patch.name}.json`),'utf8')),'library and downloadable Flux recipe agree');
  }
  const pair=fluxQuality.reports.filter(r=>r.name.startsWith(`flux-${c.id}-`));
  assert.equal(pair.length,2);assert.ok(Math.abs(pair[0].momentaryMaxLufs-pair[1].momentaryMaxLufs)<.2);
  for(const r of pair)assert.ok(r.truePeakDb<=-1&&r.lint.errors.length===0);
}
assert.equal(study.bars,8);
assert.ok(Math.abs(study.takes[0].encoded.integratedLufs-study.takes[1].encoded.integratedLufs)<.2,'A/B matched within 0.2 LU');
for(const take of study.takes){assert.ok(take.encoded.truePeakDb<=-1);songOrThrow(JSON.parse(readFileSync(resolve(site,`recipes/${take.name}.json`),'utf8')),take.name);}
// Serve the exact output under the GitHub project-site prefix, catching accidental root paths.
const server=await serveShowcase({prefix:'/agent-beeps'});
const range=await fetch(`${server.url}/agent-beeps/media/matter.mp3`,{headers:{Range:'bytes=0-99'}});
assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,100);
for(const name of ['touch','touch-plain']){
  const response=await fetch(`${server.url}/agent-beeps/media/${name}.mp3`,{headers:{Range:'bytes=0-99'}});
  assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,100);
}
for(const t of colony.tracks){
  const response=await fetch(`${server.url}/agent-beeps/media/colony-${t.id}.mp3`,{headers:{Range:'bytes=0-99'}});
  assert.equal(response.status,206,`${t.id}: byte range`);assert.equal((await response.arrayBuffer()).byteLength,100);
}
const invalid=await fetch(`${server.url}/agent-beeps/media/matter.mp3`,{headers:{Range:'bytes=999999999-'}});
assert.equal(invalid.status,416);
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const missing=[];page.on('response',r=>{if(r.url().startsWith(server.url)&&r.status()>=400)missing.push(`${r.status()} ${r.url()}`);});
  await page.goto(`${server.url}/agent-beeps/`);
  await page.waitForFunction(()=>!document.querySelector('#play').disabled);
  assert.equal(await page.locator('#pads .pad').count(),8);
  await page.waitForFunction(()=>document.querySelectorAll('[data-flux-take]').length===6);
  assert.equal(await page.locator('[data-scene]').count(),9);
  assert.equal(await page.locator('#audio').evaluate(a=>a.paused),true,'no autoplay');
  await page.waitForFunction(()=>document.querySelectorAll('#colony-pads .pad').length===9&&document.querySelectorAll('[data-colony-track]').length===7);
  assert.equal(await page.locator('#colony-pads .pad').count(),9);assert.equal(await page.locator('[data-colony-track]').count(),7);
  assert.equal(await page.locator('#colony-audio').evaluate(a=>a.paused&&!a.autoplay),true,'Colony does not autoplay');
  await page.locator('#matter-play').click();
  await page.waitForFunction(()=>document.querySelector('#audio').currentTime>.1);
  await page.getByRole('button',{name:'06 Iron',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#audio').currentTime>=45);
  assert.equal(await page.locator('#scene-title').textContent(),'Iron');
  await page.getByRole('button',{name:'Pause Matter',exact:true}).click();
  assert.equal(await page.locator('#audio').evaluate(a=>a.paused),true);
  await page.locator('#np-strip').focus();await page.keyboard.press('Home');
  await page.waitForFunction(()=>document.querySelector('#audio').currentTime<2);
  await page.getByRole('button',{name:'Stop all audio'}).click();
  await page.locator('#touch-audio').evaluate(a=>a.play());
  await page.waitForFunction(()=>document.querySelector('#touch-audio').currentTime>.15);
  await page.locator('#touch-audio').evaluate(a=>{a.currentTime=5;});
  await page.getByRole('button',{name:'B · Expressive',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#touch-audio').currentTime>=5&&!document.querySelector('#touch-audio').paused);
  assert.equal(await page.locator('#audio').evaluate(a=>a.paused),true,'comparison pauses reel');
  await page.locator('#touch-audio').evaluate(a=>a.pause());
  await page.getByRole('button',{name:'A · Plain',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#touch-audio').readyState>=1&&document.querySelector('#touch-audio').currentTime>=5);
  assert.equal(await page.locator('#touch-audio').evaluate(a=>a.paused),true,'switching a paused take stays paused');
  await page.locator('#matter-play').click();
  assert.equal(await page.locator('#touch-audio').evaluate(a=>a.paused),true,'reel pauses comparison');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#touch-audio').evaluate(a=>a.paused&&a.currentTime===0),true,'stop resets comparison');
  for(let i=0;i<8;i++){
    await page.locator('.pad .face').nth(i).click();
    await page.waitForFunction(title=>document.querySelector('#status').textContent.includes(title),session.pads[i].title);
    assert.ok(!(await page.locator('#status').textContent()).includes('Could not'),'live patch did not throw');
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.pad.playing').count(),0);
  for(const c of flux.cases)for(const take of ['static','shaped']){
    const label=take==='static'?'static index':'index envelope';
    await page.getByRole('button',{name:`Play ${c.title}: ${label}`,exact:true}).click();
    await page.waitForFunction(title=>document.querySelector('#flux-status').textContent.includes(title),c.title);
    assert.ok(!(await page.locator('#flux-status').textContent()).includes('Could not'));
    assert.equal(await page.locator(`[data-flux-case="${c.id}"]`).evaluate(el=>el.classList.contains('playing')),true);
  }
  await page.keyboard.press('Escape');assert.equal(await page.locator('.pad.playing').count(),0);
  assert.equal(await page.locator('#audio').evaluate(a=>a.paused&&a.currentTime===0),true);
  await page.locator('#matter-play').click();await page.locator('#stop').click();
  await page.getByRole('button',{name:'Repeat Matter'}).click();
  assert.equal(await page.locator('#audio').evaluate(a=>a.loop),true);
  // Independently render every shipped live patch in the browser: finite, non-silent, no overload.
  const signals=await page.evaluate(async()=>{
    const {buildPatch,patchLength}=await import('./engine/patch.js');
    const s=await(await fetch('./media/session.json')).json();
    const reports=[];
    for(const p of s.pads){
      const ctx=new OfflineAudioContext(2,Math.ceil((patchLength(p.patch)+.05)*48000),48000);
      const voice=buildPatch(ctx,p.patch,{seed:p.seed,trimDb:p.trimDb,variant:0,scale:s.scale});
      const buffer=await ctx.startRendering();let peak=0,energy=0,finite=true;
      for(let c=0;c<2;c++)for(const value of buffer.getChannelData(c)){peak=Math.max(peak,Math.abs(value));energy+=value*value;if(!Number.isFinite(value))finite=false;}
      reports.push({name:p.title,peak,energy,finite});voice.dispose();
    }
    return reports;
  });
  for(const s of signals){assert.ok(s.finite&&s.energy>0&&s.peak>0.001&&s.peak<1,`${s.name}: healthy signal`);}
  const fluxSignals=await page.evaluate(async()=>{
    const {buildPatch,patchLength}=await import('./engine/patch.js');
    const s=await(await fetch('./media/flux-session.json')).json(),reports=[];
    for(const c of s.cases){
      const channels=[];
      for(const take of ['static','shaped']){
        const item=c.takes[take],ctx=new OfflineAudioContext(2,Math.ceil((patchLength(item.patch)+.05)*48000),48000);
        const voice=buildPatch(ctx,item.patch,{seed:item.seed,trimDb:item.trimDb,scale:s.scale});
        const b=await ctx.startRendering(),ch=b.getChannelData(0);let peak=0,energy=0,finite=true;
        for(const v of ch){peak=Math.max(peak,Math.abs(v));energy+=v*v;if(!Number.isFinite(v))finite=false;}
        reports.push({name:`${c.id}/${take}`,peak,energy,finite});channels.push(ch.slice());voice.dispose();
      }
      let difference=0;for(let i=0;i<channels[0].length;i++)difference=Math.max(difference,Math.abs(channels[0][i]-channels[1][i]));
      if(difference<.001)throw new Error(`${c.id}: static/envelope sounds did not differ`);
    }
    return reports;
  });
  for(const s of fluxSignals)assert.ok(s.finite&&s.energy>0&&s.peak>.001&&s.peak<1,`${s.name}: healthy signal`);
  const fuseSignals=await testFuse(page,server,fuse,artifact);
  await testTransport(browser,server);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:resolve(artifact,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  for(const take of fuse.cases.flatMap(c=>c.takes)){
    await page.getByRole('button',{name:`Play Fuse: ${take.title}`,exact:true}).click();
    await page.waitForFunction(title=>document.querySelector('#fuse-status').textContent.includes(`${title} · playing`),take.title);
  }
  await page.keyboard.press('Escape');
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:resolve(artifact,'mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile fits viewport');
  await page.locator('#fuse').evaluate(el=>el.scrollIntoView());
  assert.ok(await page.evaluate(()=>document.querySelector('#fuse').getBoundingClientRect().top>=document.querySelector('.transport').getBoundingClientRect().bottom),'Fuse anchor clears the sticky transport');
  await page.screenshot({path:resolve(artifact,'mobile-fuse.png')});
  await page.locator('#matter-play').click();
  await page.waitForFunction(()=>!document.querySelector('#audio').paused);
  await page.getByRole('button',{name:'Stop all audio'}).click();
  await page.locator('#liner').evaluate(d=>{d.open=true;});
  assert.ok((await page.locator('#measurements').textContent()).includes('LUFS'));
  assert.deepEqual(errors,[],'browser errors');assert.deepEqual(missing,[],'missing assets');
  // Broken network gets a visible failure, rather than a permanently enabled play button.
  const failed=await browser.newPage();
  await failed.route('**/media/session.json',r=>r.fulfill({status:503,body:'unavailable'}));
  await failed.goto(`${server.url}/agent-beeps/`);
  await failed.waitForFunction(()=>document.querySelector('#status').textContent.includes('could not load'));
  assert.equal(await failed.locator('#play').isDisabled(),true);
  console.log(JSON.stringify({passed:true,checks:['project subpath','desktop and mobile','transport','A/B take switching preserves position and pause','matched A/B loudness','six live Flux patches and differing finite offline signals','nine live Fuse cues, all recording/hybrid source negative controls, actual5/1 gun groups, cross-row cancellation, licensed originals and portable metal downloads','seek keyboard','all eight live pads','Colony kit data, recipes equal to the library, byte ranges, nine pads and seven tracks without autoplay','finite audible offline signals','stop','repeat','error state','no browser errors or missing assets'],signals,fluxSignals,fuseSignals},null,2));
} finally {await browser.close();server.server.close();}
