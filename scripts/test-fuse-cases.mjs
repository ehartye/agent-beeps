import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveShowcase } from './showcase-server.mjs';

const root=resolve(import.meta.dirname,'..'),fixture=resolve(root,'.agent-beeps/task5b-controller-fixture');
mkdirSync(fixture,{recursive:true});cpSync(resolve(root,'_site'),fixture,{recursive:true});
const study=JSON.parse(readFileSync(resolve(fixture,'media/fuse-session.json'),'utf8'));
study.cases=[{id:'metal',title:'Metal contact',takes:study.takes},{id:'heavy',title:'Heavy machine gun · .50 caliber',description:'A separate comparison with the same three source types.',takes:study.takes.map(t=>({...t,title:`Heavy ${t.title}`}))}];
writeFileSync(resolve(fixture,'media/fuse-session.json'),JSON.stringify(study));
const server=await serveShowcase({rootDir:fixture,prefix:'/agent-beeps'});
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  await page.goto(`${server.url}/agent-beeps/`);
  await page.waitForFunction(()=>document.querySelectorAll('[data-fuse-take]').length>=3);
  assert.equal(await page.locator('[data-fuse-take]').count(),6,'the isolated case inventory adds a second three-take row');
  for(const [id,label]of [['recording','RECORDING'],['procedural','PURE SYNTHESIS'],['hybrid','RECORDING + SYNTHESIS']]){
    assert.equal(await page.locator(`[data-fuse-card="heavy-${id}"] .facts`).textContent(),label);
  }
  await page.getByRole('button',{name:'Play Fuse: Heavy Resonant body',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Heavy Resonant body · playing'));
  assert.equal(await page.locator('.pad.playing').count(),1);
  await page.getByRole('button',{name:'Stop all audio'}).click();
  assert.equal(await page.locator('.pad.playing').count(),0);
  assert.equal((await fetch(`${server.url}/agent-beeps/media/matter.mp3`,{headers:{Range:'bytes=0-99'}})).status,206,'isolated preview preserves reel ranges');
  console.log('Fuse isolated multirow controller, source labels, Stop and byte ranges pass.');
} finally {await browser.close();server.server.close();}
