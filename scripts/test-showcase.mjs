import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveShowcase } from './showcase-server.mjs';
import { parsePatch } from '../src/schema/patch.ts';
import { songOrThrow } from '../src/music.ts';

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
  await page.getByRole('button',{name:'Play reel',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#audio').currentTime>.1);
  await page.getByRole('button',{name:'06 Iron',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#audio').currentTime>=45);
  assert.equal(await page.locator('#scene-title').textContent(),'Iron');
  await page.getByRole('button',{name:'Pause reel',exact:true}).click();
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
  await page.getByRole('button',{name:'Play reel',exact:true}).click();
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
  await page.getByRole('button',{name:'Repeat reel'}).click();
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
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:resolve(artifact,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:resolve(artifact,'mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile fits viewport');
  await page.getByRole('button',{name:'Play reel',exact:true}).click();
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
  console.log(JSON.stringify({passed:true,checks:['project subpath','desktop and mobile','transport','A/B take switching preserves position and pause','matched A/B loudness','six live Flux patches and differing finite offline signals','seek keyboard','all eight live pads','finite audible offline signals','stop','repeat','error state','no browser errors or missing assets'],signals,fluxSignals},null,2));
} finally {await browser.close();server.server.close();}
