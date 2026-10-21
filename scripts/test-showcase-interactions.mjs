import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serveShowcase } from './showcase-server.mjs';

async function open(browser,server){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    const Native=AudioContext;
    window.AudioContext=class extends Native{constructor(...args){super(...args);window.boothContext=this;}};
    window.nativeStarts=0;
    for(const Type of [AudioBufferSourceNode,OscillatorNode]){
      const start=Type.prototype.start;
      Type.prototype.start=function(...args){nativeStarts++;return start.apply(this,args);};
    }
    window.gainTargets=[];
    const target=AudioParam.prototype.setTargetAtTime;
    AudioParam.prototype.setTargetAtTime=function(value,...rest){window.gainTargets.push(value);return target.call(this,value,...rest);};
    const play=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(...args){
      if(window.rejectMedia===this.id){window.rejectMedia=undefined;return Promise.reject(new DOMException('Test media permission rejection','NotAllowedError'));}
      if(window.holdMedia===this.id){window.mediaWaiting=true;return new Promise((resolve,reject)=>window.rejectHeldMedia=()=>{window.holdMedia=undefined;reject(new DOMException('Late media permission rejection','NotAllowedError'));});}
      return play.apply(this,args);
    };
  });
  await page.goto(`${server.url}/agent-beeps/`);
  await page.waitForFunction(()=>document.querySelectorAll('[data-fuse-take]').length===9&&document.querySelectorAll('[data-colony-track]').length===7&&document.querySelectorAll('#colony-pads .pad').length===9);
  return {page,errors};
}

async function focusedSpace(browser,server){
  const {page,errors}=await open(browser,server);
  try{
    for(const selector of ['[data-colony-track="canopy"]','[data-colony-track="the-underside"]','[data-fuse-take="tommy-recording"]','[data-flux-case="pulse-core"] [data-flux-take="shaped"]','[data-pad="7"] .face','[data-scene="5"]','#matter-play','[data-take="touch"]']){
      if(selector==='[data-take="touch"]'){
        await page.locator('#touch-audio').evaluate(a=>a.play());
        await page.waitForFunction(()=>boothContext.state==='running'&&!document.querySelector('#touch-audio').paused);
      }
      await page.locator(selector).click();
      await page.waitForFunction(()=>document.querySelector('#transport-state').textContent==='Playing').catch(async error=>{
        throw new Error(`${selector}: ${await page.locator('#transport-state').textContent()} / ${await page.locator('#np-title').textContent()} / ${await page.locator('#status').textContent()}`,{cause:error});
      });
      assert.equal(await page.locator(selector).evaluate(el=>document.activeElement===el),true);
      const starts=await page.evaluate(()=>nativeStarts);
      await page.keyboard.press('Space');await page.waitForTimeout(40);
      assert.equal(await page.locator('#transport-state').textContent(),'Paused',`${selector}: Space after a playback click pauses the shared transport`);
      await page.waitForFunction(()=>boothContext.state==='suspended');
      assert.equal(await page.evaluate(()=>nativeStarts),starts,'focused Space must not audition a fresh graph');
      await page.keyboard.press('Space');await page.waitForFunction(()=>boothContext.state==='running');
      assert.equal(await page.evaluate(()=>nativeStarts),starts,'focused Space resumes the same graph');
      await page.keyboard.press('Escape');
    }
    await page.locator('[data-fuse-take="tommy-recording"]').click();await page.waitForFunction(()=>document.querySelector('#transport-state').textContent==='Playing');
    const starts=await page.evaluate(()=>nativeStarts);
    await page.keyboard.press('Enter');await page.waitForFunction(n=>nativeStarts>n,starts);
    await page.locator('#repeat').evaluate(el=>{el.hidden=false;});await page.locator('#repeat').focus();
    await page.keyboard.press('Space');assert.equal(await page.locator('#repeat').getAttribute('aria-pressed'),'true','unrelated toggle retains native Space activation');
    await page.locator('#volume').focus();const volume=await page.locator('#volume').inputValue();
    await page.keyboard.press('Space');assert.equal(await page.locator('#volume').inputValue(),volume);
    assert.equal(await page.locator('#transport-state').textContent(),'Playing','range Space is not the global shortcut');
    await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<input id="keyboard-text" aria-label="Keyboard test field">'));
    await page.locator('#keyboard-text').fill('abc');await page.keyboard.press('Space');
    assert.equal(await page.locator('#keyboard-text').inputValue(),'abc ','text input keeps native Space typing');
    assert.equal(await page.locator('#transport-state').textContent(),'Playing');
    await page.locator('#touch-audio').focus();await page.keyboard.press('Space');
    await page.waitForFunction(()=>!document.querySelector('#touch-audio').paused&&document.querySelector('#np-title').textContent.startsWith('Touch /'));
    assert.ok((await page.locator('#np-title').textContent()).startsWith('Touch /'),'native audio Space activates its own player');
    await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('#touch-audio').paused);
    await page.keyboard.press('Escape');
  }finally{await page.close();assert.deepEqual(errors,[]);}
}

async function mediaResumeErrors(browser,server){
  const {page,errors}=await open(browser,server);
  try{
    for(const media of ['audio','touch-audio']){
      if(media==='audio')await page.locator('#matter-play').click();
      else await page.locator('#touch-audio').evaluate(a=>a.play());
      await page.waitForFunction(id=>document.getElementById(id).currentTime>.1,media);
      await page.locator('#play').click();await page.waitForFunction(()=>boothContext.state==='suspended');
      // The context suspends a moment before the media element stops, so read the position only once it has.
      await page.waitForFunction(id=>document.getElementById(id).paused,media);
      const position=await page.locator(`#${media}`).evaluate(a=>a.currentTime);
      await page.evaluate(id=>window.rejectMedia=id,media);await page.locator('#play').click();
      await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('retry'));
      assert.equal(await page.locator('#transport-state').textContent(),'Error',`${media}: rejected media resume must not claim Playing`);
      assert.equal(await page.locator('#play').getAttribute('aria-label'),`Play ${media==='audio'?'Matter':'Touch'}`);
      assert.equal(await page.locator(`#${media}`).evaluate(a=>a.paused),true);
      assert.ok(Math.abs(await page.locator(`#${media}`).evaluate(a=>a.currentTime)-position)<.001);
      await page.locator('#play').click();
      await page.waitForFunction(({id,position})=>!document.getElementById(id).paused&&document.getElementById(id).currentTime>position+.05,{id:media,position});
      assert.equal(await page.locator('#transport-state').textContent(),'Playing','the first shared Play after failure retries directly');
      assert.equal(await page.locator('#status').textContent(),'','a successful retry clears the resolved error');
      await page.keyboard.press('Escape');
    }
    await page.locator('#matter-play').click();await page.waitForFunction(()=>document.querySelector('#audio').currentTime>.1);
    await page.locator('[data-fuse-take="tommy-recording"]').click();await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Tommy recording · playing'));
    await page.locator('#play').click();await page.waitForFunction(()=>boothContext.state==='suspended');
    await page.waitForFunction(()=>document.querySelector('#audio').paused);
    const starts=await page.evaluate(()=>nativeStarts),position=await page.locator('#audio').evaluate(a=>a.currentTime);
    await page.evaluate(()=>window.rejectMedia='audio');await page.locator('#play').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('retry'));
    assert.equal(await page.locator('#np-title').textContent(),'Fuse / Tommy recording');
    assert.equal(await page.locator('#transport-state').textContent(),'Playing','a background resume error cannot relabel an audible native voice');
    assert.equal(await page.evaluate(()=>nativeStarts),starts);
    assert.equal(await page.locator('#audio').evaluate(a=>a.paused),true);
    assert.ok(Math.abs(await page.locator('#audio').evaluate(a=>a.currentTime)-position)<.001);
    await page.keyboard.press('Escape');
    // A native voice must finish on its own context clock while a media promise hangs.
    await page.locator('#matter-play').click();await page.waitForFunction(()=>document.querySelector('#audio').currentTime>.1);
    await page.locator('[data-fuse-take="recording"]').click();await page.waitForFunction(()=>document.querySelector('#fuse-status').textContent.includes('Recorded detail · playing'));
    await page.locator('#play').click();await page.waitForFunction(()=>boothContext.state==='suspended');
    await page.evaluate(()=>window.holdMedia='audio');await page.locator('#play').click();await page.waitForFunction(()=>window.mediaWaiting);
    await page.waitForFunction(()=>document.querySelector('#transport-state').textContent==='Finished');
    assert.equal(await page.locator('#np-title').textContent(),'Fuse / Recorded detail');
    await page.evaluate(()=>window.rejectHeldMedia());await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Late media'));
    assert.equal(await page.locator('#transport-state').textContent(),'Finished','late background rejection cannot overwrite the finished foreground');
    const finishedStarts=await page.evaluate(()=>nativeStarts);await page.locator('#play').click();
    await page.waitForFunction(n=>nativeStarts>n,finishedStarts);
    assert.equal(await page.locator('#np-title').textContent(),'Fuse / Recorded detail','shared Play replays the finished foreground');
    await page.keyboard.press('Escape');
    await page.locator('#matter-play').click();await page.waitForFunction(()=>document.querySelector('#audio').currentTime>.1);
    await page.locator('#play').click();await page.waitForFunction(()=>boothContext.state==='suspended');
    await page.evaluate(()=>{window.holdMedia='audio';window.mediaWaiting=false;});
    await page.locator('#play').click();await page.waitForFunction(()=>window.mediaWaiting);
    await page.locator('#stop').click();await page.evaluate(()=>window.rejectHeldMedia());await page.waitForTimeout(60);
    assert.equal(await page.locator('#transport-state').textContent(),'Stopped','a late rejected resume cannot revive or relabel stopped playback');
    assert.equal(await page.locator('#status').textContent(),'');
    assert.equal(await page.locator('#audio').evaluate(a=>a.paused&&a.currentTime===0),true);
  }finally{await page.close();assert.deepEqual(errors,[]);}
}

// A pause position saved for one Colony track must never leak into a later track or another section.
async function colonyPausedPositions(browser,server){
  const {page,errors}=await open(browser,server);
  const track=id=>`[data-colony-track="${id}"]`;
  const colony=()=>page.locator('#colony-audio');
  const pad=async()=>{
    const name=await page.locator('#colony-pads .pad .sound-name').first().textContent();
    await page.locator('#colony-pads .face').first().click();
    await page.waitForFunction(name=>document.querySelector('#colony-pad-status').textContent===`${name} · synthesized live`,name);
  };
  try{
    // Glasshouse paused at about 3 s, then a different track, then a pad: the new track keeps its own place.
    await page.locator(track('glasshouse')).click();
    await page.waitForFunction(()=>document.querySelector('#colony-audio').currentTime>.2);
    await colony().evaluate(a=>{a.currentTime=3;});
    await page.waitForFunction(()=>document.querySelector('#colony-audio').currentTime>=3);
    await page.locator('#play').click();await page.waitForFunction(()=>boothContext.state==='suspended'&&document.querySelector('#colony-audio').paused);
    await page.locator(track('canopy')).click();
    await page.waitForFunction(()=>{const a=document.querySelector('#colony-audio');return a.src.includes('colony-canopy')&&!a.paused&&a.currentTime>.1&&a.currentTime<2;});
    assert.deepEqual(await page.locator('[data-colony-track][aria-pressed="true"]').evaluateAll(els=>els.map(el=>el.dataset.colonyTrack)),['canopy']);
    const before=await colony().evaluate(a=>a.currentTime);
    await pad();
    const after=await colony().evaluate(a=>a.currentTime);
    assert.ok(after>=before&&after<before+1.5,`Canopy stays near ${before}s after a pad, not the old 3 s position (${after})`);
    await page.keyboard.press('Escape');
    // Colony paused, then Matter or Touch starts: Colony stays paused through a later pad and is not revived.
    for(const other of ['matter','touch']){
      await page.locator(track('window-light')).click();
      await page.waitForFunction(()=>document.querySelector('#colony-audio').currentTime>.2);
      await page.locator('#play').click();await page.waitForFunction(()=>boothContext.state==='suspended'&&document.querySelector('#colony-audio').paused);
      if(other==='matter')await page.locator('#matter-play').click();else await page.locator('#touch-audio').evaluate(a=>a.play());
      const id=other==='matter'?'audio':'touch-audio';
      await page.waitForFunction(id=>!document.getElementById(id).paused&&document.getElementById(id).currentTime>.1,id);
      assert.equal(await colony().evaluate(a=>a.paused),true,`${other}: Colony stays paused`);
      await pad();
      assert.equal(await colony().evaluate(a=>a.paused),true,`${other}: a pad does not revive the paused Colony track`);
      assert.equal(await page.locator(`#${id}`).evaluate(a=>a.paused),false,`${other}: keeps playing under the pad`);
      await page.keyboard.press('Escape');
    }
  }finally{await page.close();assert.deepEqual(errors,[]);}
}

async function colonyPlayback(browser,server){
  const {page,errors}=await open(browser,server);
  const track=id=>`[data-colony-track="${id}"]`;
  const colonyTime=()=>page.locator('#colony-audio').evaluate(a=>a.currentTime);
  const label=text=>page.waitForFunction(text=>document.querySelector('#meter-label').textContent===text,text);
  const title=text=>page.waitForFunction(text=>document.querySelector('#np-title').textContent.startsWith(text),text);
  const stopped=()=>page.waitForFunction(()=>[...document.querySelectorAll('audio')].every(a=>a.paused)&&document.querySelector('#colony-audio').currentTime===0);
  try{
    // A bed and a song each start from the top, advance, and name themselves on the meter.
    await page.locator(track('glasshouse')).click();
    await page.waitForFunction(()=>{const a=document.querySelector('#colony-audio');return !a.paused&&a.currentTime>.2;});
    await label('COLONY / BED');await title('Colony music / Glasshouse');
    // Switching restarts near zero, and only the new track reads as pressed.
    await page.waitForFunction(()=>document.querySelector('#colony-audio').currentTime>1);
    const before=await colonyTime();
    await page.locator(track('outpost-dawn')).click();
    await page.waitForFunction(before=>{const a=document.querySelector('#colony-audio');return a.src.includes('colony-outpost-dawn')&&!a.paused&&a.currentTime<before;},before);
    assert.deepEqual(await page.locator('[data-colony-track][aria-pressed="true"]').evaluateAll(els=>els.map(el=>el.dataset.colonyTrack)),['outpost-dawn']);
    await label('COLONY / SONG');await title('Colony music / Outpost Dawn');
    // An effect over the track ducks the music, then the same track carries on and the title returns to it.
    await page.waitForFunction(()=>document.querySelector('#colony-audio').currentTime>.5);
    const at=await colonyTime();
    await page.evaluate(()=>{
      window.gainTargets.length=0;window.titles=[];
      new MutationObserver(()=>window.titles.push(document.querySelector('#np-title').textContent)).observe(document.querySelector('#np-title'),{childList:true,characterData:true,subtree:true});
    });
    // Every pad really builds and starts: a native source starts and the status says it was synthesized.
    const names=await page.locator('#colony-pads .pad .sound-name').allTextContents();
    assert.equal(names.length,9);
    for(let i=0;i<names.length;i++){
      const starts=await page.evaluate(()=>nativeStarts);
      await page.locator('#colony-pads .face').nth(i).click();
      await page.waitForFunction(name=>document.querySelector('#colony-pad-status').textContent===`${name} · synthesized live`,names[i]);
      assert.ok(await page.evaluate(n=>nativeStarts>n,starts),`${names[i]}: the effect started native sources`);
    }
    // The pads report on their own line: the track line still describes the selected track.
    assert.match(await page.locator('#colony-status').textContent(),/^Outpost Dawn · song · /,'a pad leaves the track description alone');
    await page.waitForFunction(()=>window.titles.some(t=>t.startsWith('Colony effects /'))&&window.titles.at(-1)?.startsWith('Colony music / Outpost Dawn'));
    assert.ok(await page.evaluate(()=>window.gainTargets.includes(.32)&&window.gainTargets.lastIndexOf(1)>window.gainTargets.indexOf(.32)),'the effect ducks the music, then restores it');
    assert.equal(await page.locator('#colony-audio').evaluate(a=>a.paused),false,'the track keeps playing under the effect');
    await page.waitForFunction(at=>document.querySelector('#colony-audio').currentTime>at,at);
    // Shared Pause then Play resumes the same position.
    await page.locator('#play').click();await page.waitForFunction(()=>boothContext.state==='suspended'&&document.querySelector('#colony-audio').paused);
    const held=await colonyTime();
    assert.equal(await page.locator('#transport-state').textContent(),'Paused');
    await page.locator('#play').click();
    await page.waitForFunction(held=>{const a=document.querySelector('#colony-audio');return !a.paused&&a.currentTime>held+.1&&a.currentTime<held+3;},held);
    assert.ok(Math.abs((await colonyTime())-held)<3,'resume continues from the paused position');
    // Stop and Esc stop everything and reset to zero.
    await page.locator('#stop').click();await stopped();
    assert.equal(await page.locator('#transport-state').textContent(),'Stopped');
    await page.locator(track('window-light')).click();
    await page.waitForFunction(()=>document.querySelector('#colony-audio').currentTime>.2);
    await page.keyboard.press('Escape');await stopped();
    assert.equal(await page.locator('[data-colony-track][aria-pressed="true"]').count(),1,'the chosen track stays selected after Stop');
    // Matter, Touch and Colony take turns: starting one stops the others.
    await page.locator('#touch-audio').evaluate(a=>a.play());
    await page.waitForFunction(()=>!document.querySelector('#touch-audio').paused);
    await page.locator(track('canopy')).click();
    await page.waitForFunction(()=>!document.querySelector('#colony-audio').paused&&document.querySelector('#touch-audio').paused&&document.querySelector('#audio').paused);
    await page.locator('#matter-play').click();
    await page.waitForFunction(()=>!document.querySelector('#audio').paused&&document.querySelector('#colony-audio').paused&&document.querySelector('#touch-audio').paused);
    await page.locator(track('workshop')).click();
    await page.waitForFunction(()=>!document.querySelector('#colony-audio').paused&&document.querySelector('#audio').paused&&document.querySelector('#touch-audio').paused);
    await page.keyboard.press('Escape');await stopped();
  }finally{await page.close();assert.deepEqual(errors,[]);}
}

export async function testTransportInteractions(browser,server){
  // Keep native gesture/audio scenarios in the active page, rather than competing tabs.
  const failures=[];
  for(const test of [focusedSpace,mediaResumeErrors,colonyPlayback,colonyPausedPositions])try{await test(browser,server);}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Focused playback Space / media resume error regressions');
  console.log('Focused playback Space, native widget keys, media resume errors and Colony playback passed.');
}

if(process.argv[1]===import.meta.filename){
  const server=await serveShowcase({prefix:'/agent-beeps'}),browser=await chromium.launch({headless:true});
  try{await testTransportInteractions(browser,server);}finally{await browser.close();server.server.close();}
}
