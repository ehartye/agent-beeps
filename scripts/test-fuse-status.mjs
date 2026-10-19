import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serveShowcase } from './showcase-server.mjs';

const server=await serveShowcase();
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  await page.goto(server.url);
  await page.getByRole('button',{name:'Play Fuse: Recorded detail',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Recorded detail · playing'));
  await page.waitForFunction(()=>!document.querySelector('[data-fuse-card="recording"]').classList.contains('playing'));
  assert.equal(await page.locator('#fuse-status').textContent(),'Recorded detail · finished. Choose a take to play.','natural completion announces the finished take');
  await page.getByRole('button',{name:'Play Fuse: Recorded detail',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Recorded detail · playing'));
  let release,arrived;
  const pending=new Promise(r=>{arrived=r;});
  await page.route('**/media/fuse-hybrid.runtime.json',async route=>{arrived();await new Promise(r=>{release=r;});await route.continue();});
  await page.getByRole('button',{name:'Play Fuse: Fused strike',exact:true}).click();
  await pending;
  await page.waitForTimeout(550);
  assert.equal(await page.locator('#fuse-status').textContent(),'Loading Fused strike…','a previous take ending cannot replace the newer loading status');
  release();
  await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Fused strike · playing'));
  await page.unroute('**/media/fuse-hybrid.runtime.json');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#fuse-status').textContent(),'Stopped. Choose a take to play.');
  await page.getByRole('button',{name:'Play Fuse: Recorded detail',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Recorded detail · playing'));
  await page.getByRole('button',{name:'A · Plain',exact:true}).click();
  assert.equal(await page.locator('#touch-audio').evaluate(a=>a.paused),true);
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.pad.playing').count(),0,'an already playing voice still cleans up after a paused Touch selection cancels pending work');
  assert.equal(await page.locator('#fuse-status').textContent(),'Recorded detail · finished. Choose a take to play.');
  for(const replacement of ['Play Crystal switch','Play Alloy: index envelope']){
    await page.getByRole('button',{name:'Play Fuse: Fused strike',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Fused strike · playing'));
    await page.getByRole('button',{name:replacement,exact:true}).click();
    assert.equal(await page.locator('#fuse-status').textContent(),'Fused strike · stopped. Choose a take to play.',`${replacement} replaces the Fuse voice and its playing status`);
    await page.keyboard.press('Escape');
  }
  console.log('Fuse native natural completion and newer-request status ownership pass.');
} finally {await browser.close();server.server.close();}
