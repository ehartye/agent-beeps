import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serveShowcase } from './showcase-server.mjs';
import { testTransportInteractions } from './test-showcase-interactions.mjs';

// Observe the native graph and clocks without replacing audio behavior.
export async function testTransport(browser, server) {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(()=>{
    const Native=window.AudioContext;
    window.AudioContext=class extends Native {
      constructor(...args){super(...args);window.boothContext=this;}
      async resume(){
        if(window.holdResume){window.resumeWaiting=true;await new Promise(resolve=>window.releaseResume=resolve);window.resumeWaiting=false;}
        return super.resume();
      }
    };
    window.nativeStarts=0;
    for(const kind of [AudioBufferSourceNode,OscillatorNode]){
      const start=kind.prototype.start;
      kind.prototype.start=function(...args){window.nativeStarts++;return start.apply(this,args);};
    }
  });
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const title=()=>page.locator('#np-title').textContent();
  const state=()=>page.locator('#transport-state').textContent();
  const click=id=>page.locator(id).click();
  const waitTitle=text=>page.waitForFunction(text=>document.querySelector('#np-title').textContent.includes(text),text);
  try {
    await page.goto(`${server.url}/agent-beeps/`);
    await page.waitForFunction(()=>document.querySelectorAll('[data-fuse-take]').length===9&&document.querySelectorAll('[data-colony-track]').length===7);
    assert.equal(await page.locator('.transport #scope').count(),1,'the actual output spectrum belongs to the sticky transport');
    assert.equal(await page.locator('canvas').count(),1);
    assert.equal(await page.locator('.session #np-strip').count(),1,'Matter seek stays with its scenes');
    assert.equal(await title(),'Output monitor','idle does not claim a playing section');
    // Every collection uses its own ordered entries; Fuse crosses row boundaries.
    const collections=[
      ['#matter-play','Matter / Glass','Matter / Current'],
      ['[data-pad="0"] .face','Sound bench / Crystal switch','Sound bench / Energy shard'],
      ['[data-flux-case="alloy"] [data-flux-take="static"]','Flux / Alloy / A · Static','Flux / Alloy / B · Envelope'],
      ['[data-fuse-take="hybrid"]','Fuse / Fused strike','Fuse / Tommy recording'],
      ['[data-colony-effect="till"]','Colony effects / Soil and steel','Colony effects / A seed tucked in'],
      ['[data-colony-track="glasshouse"]','Colony music / Glasshouse','Colony music / Canopy'],
    ];
    for(const [selector,first,next]of collections){
      await click(selector);await waitTitle(first);
      const section=first.split(' / ')[0],unit=section==='Matter'?'scene':section==='Sound bench'||section==='Colony effects'?'pad':section==='Colony music'?'track':'take';
      assert.equal(await page.locator('#next').getAttribute('aria-label'),`Next ${section} ${unit}`);
      await click('#next');await waitTitle(next);
      await click('#prev');await waitTitle(first);
      await click('#stop');
    }
    const inventory=await page.evaluate(async()=>{
      const [matter,flux,fuse,colony]=await Promise.all(['session','flux-session','fuse-session','colony-session'].map(async name=>(await fetch(`./media/${name}.json`)).json()));
      return [
        ['#matter-play',matter.sections.map(s=>`Matter / ${s.name[0].toUpperCase()+s.name.slice(1)}`)],
        ['[data-pad="0"] .face',matter.pads.map(p=>`Sound bench / ${p.title}`)],
        ['[data-flux-case="alloy"] [data-flux-take="static"]',flux.cases.flatMap(c=>['A · Static','B · Envelope'].map(t=>`Flux / ${c.title} / ${t}`))],
        ['[data-fuse-take="recording"]',fuse.cases.flatMap(c=>c.takes.map(t=>`Fuse / ${t.title}`))],
        ['[data-colony-effect="till"]',colony.effects.map(e=>`Colony effects / ${e.title}`)],
        ['[data-colony-track="glasshouse"]',colony.tracks.map(t=>`Colony music / ${t.title}`)],
      ];
    });
    for(const [selector,titles]of inventory){
      await click(selector);await waitTitle(titles[0]);await click('#prev');await waitTitle(titles[0]);
      for(const expected of titles.slice(1)){await click('#next');await waitTitle(expected);}
      await click('#next');await waitTitle(titles[0]);await click('#stop');
    }
    await page.locator('#touch-audio').evaluate(a=>a.play());await waitTitle('Touch / A · Plain');
    await page.locator('#touch-audio').evaluate(a=>a.currentTime=4);
    await click('#next');await waitTitle('Touch / B · Expressive');
    await page.waitForFunction(()=>document.querySelector('#touch-audio').currentTime>=4&&!document.querySelector('#touch-audio').paused);
    assert.equal(await page.locator('#repeat').isVisible(),false,'repeat is explicitly Matter-only');
    await click('#play');const touchTime=await page.locator('#touch-audio').evaluate(a=>a.currentTime);
    await page.waitForTimeout(250);assert.equal(await page.locator('#touch-audio').evaluate(a=>a.currentTime),touchTime);
    await click('#play');await page.waitForFunction(t=>document.querySelector('#touch-audio').currentTime>t+.1,touchTime);
    await click('#play');await page.waitForFunction(()=>boothContext.state==='suspended');
    await page.evaluate(()=>window.holdResume=true);await click('#next');
    await page.waitForFunction(()=>window.resumeWaiting&&document.querySelector('#touch-audio').readyState>=1);
    await page.evaluate(()=>{window.holdResume=false;window.releaseResume();});
    await page.waitForFunction(()=>boothContext.state==='running'&&!document.querySelector('#touch-audio').paused);
    assert.ok(await page.locator('#touch-audio').evaluate(a=>a.currentTime)>=4,'a paused Touch skip preserves musical time even when metadata arrives before native resume');
    await click('#stop');
    // A native recorded voice and its ducked Matter background freeze together.
    await click('#matter-play');await page.waitForFunction(()=>document.querySelector('#audio').currentTime>.1);
    await click('[data-fuse-take="recording"]');await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('· playing'));
    const before=await page.evaluate(()=>({starts:nativeStarts,time:boothContext.currentTime}));
    await click('#play');await page.waitForFunction(()=>boothContext.state==='suspended');
    const paused=await page.evaluate(()=>({ctx:boothContext.currentTime,media:document.querySelector('#audio').currentTime}));
    assert.equal(await state(),'Paused');
    // This exceeds the original metal recording's entire duration and wall-clock timer.
    await page.waitForTimeout(3200);
    assert.deepEqual(await page.evaluate(()=>({ctx:boothContext.currentTime,media:document.querySelector('#audio').currentTime})),paused,'both real clocks freeze');
    assert.equal(await page.locator('[data-fuse-card="recording"].playing').count(),1,'paused voice survives its old wall-clock deadline');
    await page.locator('[data-take="touch"]').click();
    assert.ok((await title()).includes('Fuse / Recorded detail'),'paused Touch selection does not steal voice ownership');
    await click('#play');await page.waitForFunction(t=>boothContext.state==='running'&&boothContext.currentTime>t+.1,paused.ctx);
    assert.equal(await page.evaluate(()=>nativeStarts),before.starts,'resuming never starts a new native source');
    console.log(JSON.stringify({transportNativePause:{paused,afterResume:await page.evaluate(()=>({ctx:boothContext.currentTime,media:document.querySelector('#audio').currentTime,starts:nativeStarts})),startsBefore:before.starts,pauseWallMs:3200}}));
    await page.waitForFunction(()=>!document.querySelector('[data-fuse-card="recording"]').classList.contains('playing'));
    assert.ok((await title()).startsWith('Matter /'),'natural voice end reveals the playing background');
    await click('#stop');
    await click('[data-fuse-take="tommy-recording"]');await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('· playing'));
    await click('#play');await page.waitForFunction(()=>boothContext.state==='suspended');
    await click('#next');await waitTitle('Fuse / Tommy body');
    await page.waitForFunction(()=>boothContext.state==='running'&&document.querySelector('#fuse-status').textContent.includes('Tommy body · playing'));
    await click('#play');await page.waitForFunction(()=>boothContext.state==='suspended');
    await page.keyboard.press('Escape');const starts=await page.evaluate(()=>nativeStarts);
    await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>nativeStarts),starts);
    assert.equal(await page.locator('.pad.playing').count(),0,'stop disposes paused graph');
    // A finished take remains replayable, and media events cannot overwrite a foreground voice.
    await click('[data-pad="0"] .face');await waitTitle('Sound bench / Crystal switch');
    await page.waitForFunction(()=>document.querySelector('#transport-state').textContent==='Finished');
    await click('#play');await page.waitForFunction(()=>document.querySelector('#transport-state').textContent==='Playing');
    await page.keyboard.press('Escape');
    // The media clock must also stay frozen while a native resume request is pending.
    await click('#matter-play');await page.waitForFunction(()=>document.querySelector('#audio').currentTime>.1);
    await click('[data-fuse-take="tommy-recording"]');await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('· playing'));
    await click('#play');await page.waitForFunction(()=>boothContext.state==='suspended');
    const heldTime=await page.locator('#audio').evaluate(a=>a.currentTime);
    await page.evaluate(()=>window.holdResume=true);await click('#play');
    await page.waitForFunction(()=>window.resumeWaiting);await page.waitForTimeout(200);
    assert.equal(await page.locator('#play').getAttribute('aria-label'),'Pause Fuse','a pending resume can be paused again');
    assert.equal(await page.locator('#audio').evaluate(a=>a.paused),true,'background media stays paused until the native graph resumes');
    assert.ok(Math.abs(await page.locator('#audio').evaluate(a=>a.currentTime)-heldTime)<.001,'media cannot silently advance before the graph resumes');
    await click('#play');assert.equal(await state(),'Paused');
    await page.evaluate(()=>{window.holdResume=false;window.releaseResume();});await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>boothContext.state),'suspended','the newer pause wins an in-flight native resume');
    assert.equal(await page.locator('#audio').evaluate(a=>a.paused),true);
    await page.evaluate(()=>window.holdResume=true);await click('#play');await page.waitForFunction(()=>window.resumeWaiting);
    await click('#stop');const heldStarts=await page.evaluate(()=>nativeStarts);
    await page.evaluate(()=>{window.holdResume=false;window.releaseResume();});
    await page.waitForFunction(()=>boothContext.state==='suspended');await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>nativeStarts),heldStarts,'a late resume cannot revive a stopped voice');
    assert.equal(await state(),'Stopped');
    assert.equal(await page.locator('#audio').evaluate(a=>a.paused&&a.currentTime===0),true);
    // A stopped initial resume and a newer skip must not construct the obsolete take.
    await page.evaluate(()=>{window.holdResume=true;window.resumeWaiting=false;});
    const pendingStarts=await page.evaluate(()=>nativeStarts);
    await click('[data-fuse-take="recording"]');await page.waitForFunction(()=>window.resumeWaiting);
    await click('#next');await waitTitle('Fuse / Resonant body');
    await page.evaluate(()=>{window.holdResume=false;window.releaseResume();});
    await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Resonant body · playing'));
    assert.equal(await page.locator('[data-fuse-card="recording"].playing').count(),0);
    assert.ok(await page.evaluate(()=>nativeStarts)>pendingStarts,'the replacement really constructs a native graph');
    await click('#stop');
    // Shared skip during cue loading activates the adjacent take and cancels old work.
    let releaseCue,arrived;
    const pendingCue=new Promise(resolve=>arrived=resolve);
    await page.route('**/media/fuse-recording.runtime.json',async route=>{arrived();await new Promise(resolve=>releaseCue=resolve);await route.continue().catch(()=>{});});
    await click('[data-fuse-take="recording"]');await pendingCue;await click('#next');
    await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Resonant body · playing'));
    const replacementStarts=await page.evaluate(()=>nativeStarts);releaseCue();await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>nativeStarts),replacementStarts,'late cue completion cannot construct an obsolete graph');
    await page.unroute('**/media/fuse-recording.runtime.json');await click('#stop');
    await click('#matter-play');await page.waitForFunction(()=>!document.querySelector('#audio').paused);
    await page.route('**/media/fuse-recording.runtime.json',route=>route.fulfill({status:503,body:'unavailable'}));
    await click('[data-fuse-take="recording"]');await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('retry'));
    assert.ok((await title()).startsWith('Matter /'),'a failed foreground take reveals the still-playing background');
    assert.equal(await state(),'Playing');
    await page.unroute('**/media/fuse-recording.runtime.json');await click('#stop');
    // Hold a real media play promise after playback starts, then stop it before settlement.
    await click('[data-fuse-take="tommy-recording"]');await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Tommy recording · playing'));
    await page.evaluate(()=>{
      const play=HTMLMediaElement.prototype.play;
      window.originalMediaPlay=play;
      HTMLMediaElement.prototype.play=function(...args){
        const playing=play.apply(this,args);
        if(this.id!=='audio')return playing;
        return playing.then(()=>new Promise(resolve=>{window.mediaWaiting=true;window.releaseMedia=resolve;}));
      };
    });
    await click('#matter-play');await page.waitForFunction(()=>window.mediaWaiting);
    await click('#stop');await page.evaluate(()=>{window.releaseMedia();HTMLMediaElement.prototype.play=window.originalMediaPlay;});
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#audio').evaluate(a=>a.paused&&a.currentTime===0),true,'a late media play promise cannot undo Stop');
    assert.equal(await state(),'Stopped');
    let fail=true;
    await page.route('**/media/fuse-recording.runtime.json',route=>fail?(fail=false,route.fulfill({status:503,body:'unavailable'})):route.continue());
    await click('[data-fuse-take="recording"]');await page.waitForFunction(()=>document.querySelector('#transport-state').textContent==='Error');
    assert.equal(await page.locator('#play').getAttribute('aria-label'),'Play Fuse');await click('#play');
    await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Recorded detail · playing'));
    await page.unroute('**/media/fuse-recording.runtime.json');await click('#stop');
    await page.locator('#fuse').evaluate(el=>el.scrollIntoView());
    assert.ok(await page.locator('.transport').evaluate(el=>el.getBoundingClientRect().height<=215),'390px sticky monitor remains compact');
    assert.ok(await page.evaluate(()=>document.querySelector('#fuse').getBoundingClientRect().top>=document.querySelector('.transport').getBoundingClientRect().bottom),'section clears measured transport height');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
  } finally {await page.close();}
  await testTransportInteractions(browser,server);
}

if(process.argv[1]===import.meta.filename){
  const server=await serveShowcase({prefix:'/agent-beeps'}),browser=await chromium.launch({headless:true});
  try {await testTransport(browser,server);console.log('Shared transport native clocks, collections and ownership passed.');}
  finally {await browser.close();server.server.close();}
}
