import { buildPatch } from './engine/patch.js';
import { buildLimiter } from './engine/fx.js';
import { build, parseCue, loadCueAssets } from './engine/index.js';

const $ = selector => document.querySelector(selector);
const audio = $('#audio');
const touch = $('#touch-audio');
const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const sceneCopy = [
  ['Glass', 'A struck overtone hangs in the air. A few grains of dust answer.', 'ADDITIVE PARTIALS / POISSON GRAINS'],
  ['Current', 'A rubbery bass finds its footing. Five metallic ticks turn against the four-beat grid.', 'FM BASS / EUCLIDEAN PERCUSSION'],
  ['Circuit', 'The glass becomes a hook. Ghost notes and offbeat electric keys make space around it.', 'BROKEN BEAT / SEEDED HUMANIZATION'],
  ['Fracture', 'Pull the kick. Dim the keys. The groove keeps moving even as its floor disappears.', 'SUBTRACTIVE ARRANGEMENT / FILTER CONTRAST'],
  ['Pressure', 'Two rough-edged strings open slowly. The cabinet filter lets the teeth through.', 'ADDITIVE STRINGS / DRIVE / FILTER AUTOMATION'],
  ['Iron', 'Displaced chugs, a half-time backbeat and a struck anvil. Two performances spread the riff wide.', 'DOUBLE-TRACKING / MODAL METAL / SYNCOPATION'],
  ['Vacuum', 'The machinery falls away. Listen to the space it leaves behind.', 'DENSITY DROP / REVERB TAILS'],
  ['Bloom', 'A vowel-shaped choir opens the harmony. The minor key catches a warmer light.', 'FORMANT SYNTHESIS / VOICE-LED EXTENDED CHORDS'],
  ['Afterglow', 'One last suspended colour. The glass returns; the world settles back into grains.', 'MOTIF RETURN / NATURAL DECAY'],
];
let session, ctx, master, musicGain, sfxGain, analyser, voice, voiceTimer, voiceFeedback, sceneIndex = -1, playRequest = 0;
let bins, animation = 0, padRequest = 0, padAbort, takeRequest = 0;
let selected, foreground, transportState = 'Idle', paused = false, transportRequest = 0;
let contextQueue = Promise.resolve(), contextWanted = false;
const pausedMedia = new Map();
const mediaWanted = new Map([[audio,false],[touch,false]]);
const permissionPauses = new WeakSet();
const collections = {Matter:[], 'Sound bench':[], Touch:[], Flux:[], Fuse:[]};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const status = text => { $('#status').textContent = text; };
function register(section, title, run) {
  const entry={section,title,index:collections[section].length,run};
  collections[section].push(entry);
  return entry;
}
function choose(entry, state) {selected=entry;transportState=state;paintTransport();}
function backgroundEntry() {
  if(!touch.paused || paused&&pausedMedia.has(touch))return collections.Touch[touchTakeIndex()];
  if(!audio.paused || paused&&pausedMedia.has(audio))return collections.Matter[Math.max(0,sceneIndex)];
}
function revealBackground(state='Finished') {
  const background=backgroundEntry();
  if(background)choose(background,paused?'Paused':'Playing');
  else {transportState=state;paintTransport();}
}
function paintTransport() {
  const active=transportState==='Playing' || transportState==='Loading';
  $('#np-title').textContent=selected?`${selected.section} / ${selected.title}`:'Output monitor';
  $('#np-desc').textContent=selected?`${selected.index+1} / ${collections[selected.section].length}`:'Choose a scene, pad or take below.';
  $('#transport-state').textContent=transportState==='Idle'?'Ready when you are':transportState;
  $('#led').classList.toggle('on',active);
  $('#play').textContent=active?'❚❚':'▶';
  $('#play').setAttribute('aria-label',`${active?'Pause':'Play'} ${selected?.section??'Matter'}`);
  const section=selected?.section??'Matter',unit=section==='Matter'?'scene':section==='Sound bench'?'pad':'take';
  $('#prev').setAttribute('aria-label',`Previous ${section} ${unit}`);
  $('#next').setAttribute('aria-label',`Next ${section} ${unit}`);
  $('#repeat').hidden=selected?.section!=='Matter';
}
function initAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();master.gain.value = Number($('#volume').value) / 100;
    analyser = ctx.createAnalyser();analyser.fftSize = 2048;analyser.smoothingTimeConstant = .78;
    bins = new Uint8Array(analyser.frequencyBinCount);
    musicGain = ctx.createGain();sfxGain = ctx.createGain();
    const safety = buildLimiter(ctx);
    ctx.createMediaElementSource(audio).connect(musicGain).connect(safety);
    ctx.createMediaElementSource(touch).connect(musicGain);
    sfxGain.connect(safety);safety.connect(master).connect(analyser).connect(ctx.destination);
    ctx.addEventListener('statechange',()=>{
      clearTimeout(voiceTimer);
      if(ctx.state==='running'&&!paused)armVoiceTimer();
      draw();
    });
  }
  return setContextRunning(true);
}
// Serialize native transitions. The latest intent also supersedes queued transitions.
function setContextRunning(running) {
  contextWanted=running;
  if(!ctx)return Promise.resolve();
  contextQueue=contextQueue.catch(()=>{}).then(async()=>{
    if(contextWanted && ctx.state!=='running')await ctx.resume();
    if(!contextWanted && ctx.state==='running')await ctx.suspend();
  });
  return contextQueue;
}
function musicLevel(value) {
  if (!ctx) return;
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.setTargetAtTime(value, ctx.currentTime, .045);
}
function armVoiceTimer() {
  clearTimeout(voiceTimer);
  if(!voice || paused || ctx.state!=='running')return;
  const playingVoice=voice;
  voiceTimer=setTimeout(()=>{
    if(voice!==playingVoice || paused || ctx.state!=='running')return;
    if(ctx.currentTime<voice.end+.04){armVoiceTimer();return;}
    stopPad(true);foreground=undefined;revealBackground();draw();
  },Math.max(10,(voice.end-ctx.currentTime+.06)*1000));
}
function stopPad(finished = false) {
  clearTimeout(voiceTimer);
  if (voice) { voice.dispose(); voice = null; }
  document.querySelectorAll('.pad.playing').forEach(el => el.classList.remove('playing'));
  voiceFeedback?.(finished?'finished':'stopped');voiceFeedback=undefined;musicLevel(1);
}
function cancelPendingPad(){
  ++padRequest;padAbort?.abort();padAbort=undefined;
  if($('#fuse-status').textContent.startsWith('Loading '))$('#fuse-status').textContent='Choose a take to play.';
  if(foreground && !voice){foreground=undefined;revealBackground('Stopped');}
}
function pauseMedia(media) {mediaWanted.set(media,false);media.pause();}
async function startMedia(media,resumed,current,position=media.currentTime) {
  // Request media permission in the gesture, but keep its clock frozen until output runs.
  const playing=media.play();
  if(ctx.state!=='running'){
    if(!media.paused)permissionPauses.add(media);
    media.pause();void playing.catch(()=>{});
    await resumed;
    if(!current()||!mediaWanted.get(media))return;
    media.currentTime=position;
    await media.play();
  }else await Promise.all([resumed,playing]);
  if(!mediaWanted.get(media))media.pause();
}
function stopAll() {
  ++transportRequest;cancelPendingPad();++playRequest;++takeRequest;
  pausedMedia.clear();paused=false;
  pauseMedia(audio);audio.currentTime=0;pauseMedia(touch);touch.currentTime=0;
  stopPad();foreground=undefined;void setContextRunning(false);
  status('');$('#fuse-status').textContent='Stopped. Choose a take to play.';
  transportState='Stopped';paint();paintTransport();draw();
}
async function restoreMedia() {
  const saved=[...pausedMedia],request=transportRequest;pausedMedia.clear();
  let failed=false;
  await Promise.all(saved.map(async([media,position])=>{
    media.currentTime=position;mediaWanted.set(media,true);
    try {await media.play();}
    catch(error){
      if(request!==transportRequest||!mediaWanted.get(media))return;
      failed=true;
      pauseMedia(media);
      status(`Playback could not start. Press Play to retry. ${error.message}`);
      const section=media===audio?'Matter':'Touch';
      if(!foreground&&selected?.section===section){
        // Keep a failed sole media resume at its exact position for shared Play to retry.
        pausedMedia.set(media,position);transportState='Error';paintTransport();
      }
    }
    if(!mediaWanted.get(media))media.pause();
  }));
  return failed;
}
async function pauseShared() {
  ++transportRequest;++playRequest;++takeRequest;cancelPendingPad();paused=true;
  for(const media of [audio,touch]){
    if(!media.paused)pausedMedia.set(media,media.currentTime);
    pauseMedia(media);
  }
  clearTimeout(voiceTimer);transportState='Paused';paintTransport();
  await setContextRunning(false);draw();
}
async function resumeShared() {
  if(!voice&&!pausedMedia.size){paused=false;return (selected??collections.Matter[0])?.run();}
  const request=++transportRequest;paused=false;
  transportState='Loading';paintTransport();
  try {
    await initAudio();
    if(request!==transportRequest || paused)return;
    // Native voice time advances immediately, even if a saved media promise is still pending.
    armVoiceTimer();
    if(voice){transportState='Playing';paintTransport();draw();}
    const mediaFailed=await restoreMedia();
    if(request!==transportRequest || paused)return;
    if(voice)choose(foreground,'Playing');
    else if(!audio.paused || !touch.paused)revealBackground('Playing');
    else if(transportState==='Loading')transportState='Paused';
    if(!mediaFailed&&(voice||!audio.paused||!touch.paused))status('');
    paintTransport();draw();
  } catch(error){if(request===transportRequest){transportState='Error';paintTransport();status(`Playback could not start. Press Play to retry. ${error.message}`);}}
}
async function play(at) {
  if (!session) return;
  ++transportRequest;++takeRequest;paused=false;pausedMedia.delete(touch);
  cancelPendingPad();pauseMedia(touch);
  const request = ++playRequest;
  try {
    const resumed = initAudio();
    if (at != null) audio.currentTime = Math.max(0, Math.min(session.durationSec, at));
    if(audio.ended)audio.currentTime=0;
    pausedMedia.delete(audio);mediaWanted.set(audio,true);paint();
    if(!foreground)choose(collections.Matter[Math.max(0,sceneIndex)],'Playing');
    await startMedia(audio,resumed,()=>request===playRequest);
    if (request !== playRequest){if(!mediaWanted.get(audio))audio.pause();return;}
    status('');armVoiceTimer();draw();
  } catch (error) {
    if (request === playRequest){mediaWanted.set(audio,false);if(!foreground){transportState='Error';paintTransport();}status(`Playback could not start. Press Play to retry. ${error.message}`);}
  }
}
async function strike(index) {if(session)return collections['Sound bench'][index].run();}
async function strikeSound(item, selector, scale, feedback = status, entry) {
  ++transportRequest;cancelPendingPad();
  const request = padRequest,controller = padAbort = new AbortController();
  stopPad();paused=false;foreground=entry;choose(entry,'Loading');
  if(item.cue)feedback(`Loading ${item.title}…`);
  try {
    await initAudio();
    if (request !== padRequest) return;
    restoreMedia();
    let cue, samples;
    if(item.cue){
      const url=new URL(item.cue,location.href),response=await fetch(url,{signal:controller.signal});
      if(!response.ok)throw new Error(`Take returned ${response.status}`);
      cue=parseCue(await response.json());samples=await loadCueAssets(ctx,cue,{baseURL:url,signal:controller.signal});
      if(request!==padRequest)return;
    }
    musicLevel(.32);
    voice = cue ? build(ctx,sfxGain,cue,{samples}).start(ctx.currentTime+.012)
      : buildPatch(ctx, item.patch, { destination:sfxGain, when:ctx.currentTime + .012, seed:item.seed, variant:0, trimDb:item.trimDb, scale });
    padAbort=undefined;$(selector).classList.add('playing');
    voiceFeedback=cue?state=>feedback(`${item.title} · ${state}. Choose a take to play.`):undefined;
    armVoiceTimer();choose(entry,'Playing');feedback(`${item.title} · ${cue?'playing':'synthesized live'}`);draw();
  } catch (error) { if(request===padRequest){stopPad();foreground=undefined;revealBackground('Error');feedback(`Could not play this patch. Press it to retry. ${error.message}`);} }
}
function paint() {
  if (!session) return;
  const t=audio.currentTime,fraction=Math.min(1,t/session.durationSec);
  $('#np-strip .played').style.width=`${fraction*100}%`;$('#np-strip .head').style.left=`${fraction*100}%`;
  $('#np-strip').setAttribute('aria-valuenow',String(Math.round(fraction*100)));
  $('#np-strip').setAttribute('aria-valuetext',`${clock(t)} of ${clock(session.durationSec)}`);$('#pos').textContent=clock(t);
  let index=session.sections.findIndex(s=>t>=s.start&&t<s.end);
  if(index<0)index=session.sections.length-1;
  if(index!==sceneIndex){
    sceneIndex=index;const [title,desc,tech]=sceneCopy[index];
    $('#scene-number').textContent=`SCENE ${String(index+1).padStart(2,'0')} / ${clock(session.sections[index].start)}`;
    $('#scene-title').textContent=title;$('#scene-detail').textContent=desc;$('#scene-tech').textContent=tech;$('#sec').textContent=title;
    document.querySelectorAll('[data-scene]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.scene)===index)));
  }
  if(!foreground&&selected?.section==='Matter'){selected=collections.Matter[index];paintTransport();}
}
function draw() {
  if(animation||document.hidden)return;
  const frame=()=>{
    animation=0;const canvas=$('#scope'),g=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
    g.clearRect(0,0,w,h);g.strokeStyle='#b5d4ce18';g.lineWidth=1;
    for(let y=30;y<h;y+=40){g.beginPath();g.moveTo(0,y);g.lineTo(w,y);g.stroke();}
    const active=analyser&&ctx.state==='running'&&(!audio.paused||!touch.paused||voice);
    if(active){
      analyser.getByteFrequencyData(bins);const count=100;
      for(let i=0;i<count;i++){
        const lo=Math.floor((40*(400**(i/count)))/ctx.sampleRate*analyser.fftSize);
        const hi=Math.max(lo+1,Math.ceil((40*(400**((i+1)/count)))/ctx.sampleRate*analyser.fftSize));
        let peak=0;for(let b=lo;b<Math.min(hi,bins.length);b++)peak=Math.max(peak,bins[b]);
        const v=peak/255;g.fillStyle=i>74?'#ffae42':'#91c5ba';g.fillRect(i*w/count,h-v*(h-10),w/count-3,Math.max(1,v*(h-10)));
      }
      $('#meter-label').textContent=voice?'LIVE PATCH + OUTPUT':!touch.paused?'TOUCH / PERFORMANCE STUDY':'REEL OUTPUT';
    }else{
      g.strokeStyle='#91c5ba55';g.beginPath();g.moveTo(0,h-2);g.lineTo(w,h-2);g.stroke();
      $('#meter-label').textContent=paused?'SIGNAL PAUSED':'AWAITING SIGNAL';
    }
    if(active&&!reducedMotion.matches)animation=requestAnimationFrame(frame);
  };frame();
}

function makeStrip() {
  const el=$('#np-strip');
  session.sections.forEach((s,i)=>{
    const band=document.createElement('div');band.className='band';
    band.style.cssText=`left:${s.start/session.durationSec*100}%;width:${(s.end-s.start)/session.durationSec*100}%;background:var(--sec-${i%6+1})`;
    const label=document.createElement('span');label.textContent=s.name;band.append(label);el.append(band);
  });
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox',`0 0 ${session.arc.length} 100`);svg.setAttribute('preserveAspectRatio','none');
  const line=document.createElementNS(svg.namespaceURI,'polyline');
  line.setAttribute('points',session.arc.map((v,i)=>`${i+.5},${96-(Math.max(-45,Math.min(-5,v))+45)/40*92}`).join(' '));
  for(const [k,v]of Object.entries({fill:'none',stroke:'var(--arc)','stroke-width':'2','vector-effect':'non-scaling-stroke'}))line.setAttribute(k,v);
  svg.append(line);el.append(svg);
  for(const className of ['played','head']){const d=document.createElement('div');d.className=className;el.append(d);}
  const seek=e=>{const r=el.getBoundingClientRect();void play((e.clientX-r.left)/r.width*session.durationSec);};
  el.addEventListener('pointerdown',e=>{el.setPointerCapture(e.pointerId);seek(e);});
  el.addEventListener('pointermove',e=>{if(el.hasPointerCapture(e.pointerId))seek(e);});
  el.addEventListener('keydown',e=>{
    const target={ArrowLeft:audio.currentTime-5,ArrowRight:audio.currentTime+5,Home:0,End:session.durationSec-.1}[e.key];
    if(target!=null){e.preventDefault();void play(target);}
  });
}
async function load() {
  try {
    const response=await fetch('./media/session.json');
    if(!response.ok)throw new Error(`Session returned ${response.status}`);
    session=await response.json();
    $('#spec').textContent=`${clock(session.durationSec)} / 128 BPM / 13 PARTS / 8 SOURCE TYPES`;
    $('#dur').textContent=clock(session.durationSec);
    $('#measurements').textContent=`The delivered reel measures ${session.loudnessLufs.toFixed(1)} LUFS integrated, with a ${session.truePeakDb.toFixed(1)} dBTP peak and ${session.loudnessRangeLu.toFixed(1)} LU of loudness range. Playback starts at 75% volume.`;
    makeStrip();
    session.sections.forEach((s,i)=>{
      register('Matter',sceneCopy[i][0],()=>play(s.start));
      const button=document.createElement('button');button.className='toggle';button.dataset.scene=i;
      button.textContent=`${String(i+1).padStart(2,'0')} ${sceneCopy[i][0]}`;button.title=`Jump to ${clock(s.start)}`;
      button.onclick=()=>play(s.start);$('#chapters').append(button);
    });
    session.pads.forEach((p,i)=>{
      const entry=register('Sound bench',p.title,()=>strikeSound(p,`[data-pad="${i}"]`,session.scale,status,entry));
      const card=document.createElement('article');card.className='pad';card.dataset.pad=i;
      const button=document.createElement('button');button.className='face';button.setAttribute('aria-label',`Play ${p.title}`);
      const img=document.createElement('img');img.src=p.look;img.alt='';img.loading='lazy';button.append(img);
      for(const [cls,text] of [['pad-number',String(i+1).padStart(2,'0')],['play-glyph','▶']]){const span=document.createElement('span');span.className=cls;span.textContent=text;button.append(span);}
      button.onclick=()=>strike(i);card.append(button);
      for(const [tag,cls,text] of [['h3','sound-name',p.title],['p','sound-purpose',p.description],['span','facts',p.sources.join(' + ').toUpperCase()]]){const el=document.createElement(tag);el.className=cls;el.textContent=text;card.append(el);}
      const link=document.createElement('a');link.href=`./recipes/${p.patch.name}.json`;link.textContent='Open patch ↗';link.target='_blank';link.rel='noopener';card.append(link);
      $('#pads').append(card);
    });
    for(const selector of ['#play','#prev','#next'])$(selector).disabled=false;
    $('#matter-play').disabled=false;
    paint();paintTransport();draw();
  } catch(error) {status(`The session could not load. Reload the page to retry. ${error.message}`);$('#spec').textContent='Session unavailable';}
}
$('#play').onclick=()=>{if(transportState==='Playing'||transportState==='Loading')void pauseShared();else void resumeShared();};
$('#matter-play').onclick=()=>play();
$('#stop').onclick=stopAll;
function skip(direction){
  const entry=selected??collections.Matter[0],list=collections[entry.section];
  const index=direction<0?Math.max(0,entry.index-1):(entry.index+1)%list.length;
  void list[index].run();
}
$('#prev').onclick=()=>skip(-1);
$('#next').onclick=()=>skip(1);
$('#repeat').onclick=e=>{audio.loop=!audio.loop;e.currentTarget.setAttribute('aria-pressed',String(audio.loop));};
$('#volume').oninput=e=>{if(master)master.gain.setTargetAtTime(Number(e.target.value)/100,ctx.currentTime,.02);};
audio.addEventListener('timeupdate',paint);
for(const [media,section]of [[audio,'Matter'],[touch,'Touch']]){
  media.addEventListener('playing',()=>{
    if(!mediaWanted.get(media)){media.pause();return;}
    if(!foreground&&!paused)choose(section==='Matter'?collections.Matter[Math.max(0,sceneIndex)]:collections.Touch[touchTakeIndex()],'Playing');
  });
  media.addEventListener('pause',()=>{
    if(permissionPauses.has(media)){permissionPauses.delete(media);return;}
    if(!media.paused)return;
    mediaWanted.set(media,false);
    if(!foreground&&!paused&&selected?.section===section&&transportState==='Playing'){
      transportState=media.ended?'Finished':'Paused';paintTransport();
    }
    draw();
  });
  media.addEventListener('ended',()=>{
    if(!foreground&&selected?.section===section){transportState='Finished';paintTransport();}draw();
  });
  media.addEventListener('error',()=>{
    if(!foreground&&selected?.section===section){transportState='Error';paintTransport();}
  });
}
audio.addEventListener('error',()=>status('The audio could not load. Check your connection and press Play to retry.'));
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){stopAll();return;}
  if(e.defaultPrevented||e.ctrlKey||e.metaKey||e.altKey)return;
  const nativeWidget=e.target.closest('button,input,textarea,select,a,audio,[role="slider"],[contenteditable],summary');
  const playbackEntry=e.target.closest('#matter-play,[data-scene],#pads .face,[data-take],[data-flux-take],[data-fuse-take],.controls button');
  if(e.key===' '&&(!nativeWidget||playbackEntry)){
    e.preventDefault();if(!e.repeat)$('#play').click();return;
  }
  if(nativeWidget||e.repeat)return;
  if(/^[1-8]$/.test(e.key)){e.preventDefault();void strike(Number(e.key)-1);}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(animation);animation=0;}else draw();});
const takeCopy = {
  'touch-plain': 'A · Plain: velocity changes loudness.',
  touch: 'B · Expressive: tone, attack, pitch and brightness follow the performance.',
};
function touchTakeIndex(){return $('[data-take="touch"]').getAttribute('aria-pressed')==='true'?1:0;}
function activateTouch(){
  ++transportRequest;++playRequest;cancelPendingPad();pauseMedia(audio);pausedMedia.delete(audio);
  stopPad();foreground=undefined;paused=false;pausedMedia.delete(touch);mediaWanted.set(touch,true);
  choose(collections.Touch[touchTakeIndex()],'Playing');
}
touch.addEventListener('play',async()=>{
  if(touch.paused)return;
  if(mediaWanted.get(touch)){draw();return;}
  activateTouch();const request=++takeRequest;
  try {await startMedia(touch,initAudio(),()=>request===takeRequest);if(request===takeRequest&&mediaWanted.get(touch))draw();}
  catch(error){if(request===takeRequest){pauseMedia(touch);transportState='Error';paintTransport();$('#touch-status').textContent=`Playback could not start. ${error.message}`;}}
});
touch.addEventListener('error',()=>{$('#touch-status').textContent='This take could not load. Choose a take to retry.';});
async function switchTouch(button,forcePlay=false){
  cancelPendingPad();
  const request=++takeRequest,position=pausedMedia.get(touch)??touch.currentTime,playing=forcePlay||!touch.paused;
  pauseMedia(touch);
  for(const b of document.querySelectorAll('[data-take]'))b.setAttribute('aria-pressed',String(b===button));
  $('#touch-status').textContent=takeCopy[button.dataset.take];
  touch.src=`./media/${button.dataset.take}.mp3`;
  touch.onloadedmetadata=()=>{
    if(request!==takeRequest)return;
    touch.currentTime=Math.min(position,Math.max(0,touch.duration-.01));
  };
  // Request playback within the click gesture; metadata restores the position before audio advances.
  if(playing){
    activateTouch();
    try {await startMedia(touch,initAudio(),()=>request===takeRequest,position);draw();}
    catch(error){if(request===takeRequest){pauseMedia(touch);transportState='Error';paintTransport();$('#touch-status').textContent=`Press Play to continue. ${error.message}`;}}
  }else if(!foreground&&selected?.section==='Touch'){
    choose(collections.Touch[touchTakeIndex()],'Paused');
  }
}
for(const button of document.querySelectorAll('[data-take]')){
  register('Touch',button.textContent,()=>switchTouch(button,true));
  button.onclick=()=>switchTouch(button);
}
new ResizeObserver(()=>document.documentElement.style.setProperty('--transport-clearance',`${Math.ceil($('.transport').getBoundingClientRect().height)+16}px`)).observe($('.transport'));
void load();
async function loadFlux(){
  const feedback=text=>{$('#flux-status').textContent=text;};
  try {
    const response=await fetch('./media/flux-session.json');
    if(!response.ok)throw new Error(`Study returned ${response.status}`);
    const study=await response.json();
    for(const c of study.cases){
      const card=document.createElement('article');card.className='pad';card.dataset.fluxCase=c.id;
      const face=document.createElement('div');face.className='face';
      const img=document.createElement('img');img.src=c.takes.shaped.look;img.alt=`Waveform and spectrum of ${c.title} with its index envelope`;img.loading='lazy';face.append(img);card.append(face);
      const title=document.createElement('h3');title.className='sound-name';title.textContent=c.title;card.append(title);
      const description=document.createElement('p');description.className='sound-purpose';description.textContent=c.description;card.append(description);
      const row=document.createElement('div');row.className='row';
      for(const [take,label]of [['static','A · Static'],['shaped','B · Envelope']]){
        const item=c.takes[take];
        const button=document.createElement('button');button.className='toggle';button.textContent=label;button.dataset.fluxTake=take;
        button.setAttribute('aria-label',`Play ${c.title}: ${take==='static'?'static index':'index envelope'}`);
        const entry=register('Flux',`${c.title} / ${label}`,()=>strikeSound({...item,title:`${c.title} / ${label}`},`[data-flux-case="${c.id}"]`,study.scale,feedback,entry));
        button.onclick=entry.run;
        row.append(button);
      }
      card.append(row);
      const recipes=document.createElement('div');
      for(const [take,label]of [['static','Static patch'],['shaped','Envelope patch']]){
        const a=document.createElement('a');a.href=`./recipes/${c.takes[take].patch.name}.json`;a.textContent=label+' ↗';a.target='_blank';a.rel='noopener';recipes.append(a);
        if(take==='static')recipes.append(document.createTextNode(' · '));
      }
      card.append(recipes);
      $('#flux-pads').append(card);
    }
    feedback('Choose A or B. Each press builds the patch in your browser.');
  } catch(error){feedback(`The synthesis study could not load. Reload to retry. ${error.message}`);}
}
void loadFlux();
async function loadFuse(){
  const feedback=text=>{$('#fuse-status').textContent=text;};
  try {
    const response=await fetch('./media/fuse-session.json');
    if(!response.ok)throw new Error(`Study returned ${response.status}`);
    const study=await response.json();
    const sourceLabels={recording:'RECORDING',procedural:'PURE SYNTHESIS',hybrid:'RECORDING + SYNTHESIS'};
    const cases=study.cases??[{id:'metal',takes:study.takes}];
    for(const material of cases){
      if(material.title){
        const heading=document.createElement('div');heading.className='fuse-case';
        const title=document.createElement('h3');title.textContent=material.title;heading.append(title);
        if(material.description){const p=document.createElement('p');p.textContent=material.description;heading.append(p);}
        if(material.credits){
          const credits=document.createElement('p');credits.className='facts';
          for(const [i,credit]of material.credits.entries()){
            if(i)credits.append(document.createTextNode(' · '));
            const link=document.createElement('a');link.href=credit.url;link.textContent=credit.title;credits.append(link);
          }
          heading.append(credits);
        }
        $('#fuse-pads').append(heading);
      }
      for(const take of material.takes){
      const id=material.id==='metal'?take.id:`${material.id}-${take.id}`;
      const card=document.createElement('article');card.className='pad';card.dataset.fuseCard=id;
      const button=document.createElement('button');button.className='face';button.dataset.fuseTake=id;
      button.setAttribute('aria-label',`Play Fuse: ${take.title}`);
      const img=document.createElement('img');img.src=take.look;img.alt='';img.loading='lazy';button.append(img);
      const glyph=document.createElement('span');glyph.className='play-glyph';glyph.textContent='▶';button.append(glyph);
      const entry=register('Fuse',take.title,()=>strikeSound(take,`[data-fuse-card="${id}"]`,undefined,feedback,entry));
      button.onclick=entry.run;card.append(button);
      for(const [tag,cls,text]of [['h3','sound-name',take.title],['p','sound-purpose',take.description],['span','facts',sourceLabels[take.id]]]){
        const el=document.createElement(tag);el.className=cls;el.textContent=text;card.append(el);
      }
      const link=document.createElement('a');link.href=take.patch;link.textContent='Inspect patch ↗';link.target='_blank';link.rel='noopener';card.append(link);
      $('#fuse-pads').append(card);
      }
    }
    feedback('Choose a take. The recording and synthesis meet live in your browser.');
  } catch(error){feedback(`The material study could not load. Reload to retry. ${error.message}`);}
}
void loadFuse();
