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
// Serve the exact output under the GitHub project-site prefix, catching accidental root paths.
const server=await serveShowcase({prefix:'/agent-beeps'});
const range=await fetch(`${server.url}/agent-beeps/media/matter.mp3`,{headers:{Range:'bytes=0-99'}});
assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,100);
const invalid=await fetch(`${server.url}/agent-beeps/media/matter.mp3`,{headers:{Range:'bytes=999999999-'}});
assert.equal(invalid.status,416);
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const missing=[];page.on('response',r=>{if(r.url().startsWith(server.url)&&r.status()>=400)missing.push(`${r.status()} ${r.url()}`);});
  await page.goto(`${server.url}/agent-beeps/`);
  await page.waitForFunction(()=>!document.querySelector('#play').disabled);
  assert.equal(await page.locator('.pad').count(),8);
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
  for(let i=0;i<8;i++){
    await page.locator('.pad .face').nth(i).click();
    await page.waitForFunction(title=>document.querySelector('#status').textContent.includes(title),session.pads[i].title);
    assert.ok(!(await page.locator('#status').textContent()).includes('Could not'),'live patch did not throw');
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.pad.playing').count(),0);
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
  console.log(JSON.stringify({passed:true,checks:['project subpath','desktop and mobile','transport','seek keyboard','all eight live pads','finite audible offline signals','stop','repeat','error state','no browser errors or missing assets'],signals},null,2));
} finally {await browser.close();server.server.close();}
