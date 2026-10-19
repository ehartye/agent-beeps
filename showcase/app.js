import { buildPatch } from './engine/patch.js';
import { buildLimiter } from './engine/fx.js';

const $ = selector => document.querySelector(selector);
const audio = $('#audio');
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
let session, ctx, master, musicGain, sfxGain, analyser, voice, voiceTimer, sceneIndex = -1, playRequest = 0;
let bins, animation = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const status = text => { $('#status').textContent = text; };
function initAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = Number($('#volume').value) / 100;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = .78;
    bins = new Uint8Array(analyser.frequencyBinCount);
    musicGain = ctx.createGain();
    sfxGain = ctx.createGain();
    const safety = buildLimiter(ctx);
    ctx.createMediaElementSource(audio).connect(musicGain).connect(safety);
    sfxGain.connect(safety);
    safety.connect(master).connect(analyser).connect(ctx.destination);
  }
  return ctx.resume();
}
function musicLevel(value) {
  if (!ctx) return;
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.setTargetAtTime(value, ctx.currentTime, .045);
}
function stopPad() {
  clearTimeout(voiceTimer);
  if (voice) { voice.dispose(); voice = null; }
  document.querySelectorAll('.pad.playing').forEach(el => el.classList.remove('playing'));
  musicLevel(1);
}
function stopAll() {
  ++playRequest;
  audio.pause();
  audio.currentTime = 0;
  stopPad();
  status('');
  paint();
}
async function play(at) {
  if (!session) return;
  const request = ++playRequest;
  try {
    // Both are requested within the user gesture, including Safari's media permission.
    const resumed = initAudio();
    if (at != null) { audio.currentTime = Math.max(0, Math.min(session.durationSec, at)); paint(); }
    const playing = audio.play();
    await Promise.all([resumed, playing]);
    if (request !== playRequest) return;
    status('');
    draw();
  } catch (error) {
    if (request === playRequest) status(`Playback could not start. Press Play to retry. ${error.message}`);
  }
}
async function strike(index) {
  if (!session) return;
  const item = session.pads[index];
  const request = ++padRequest;
  try {
    await initAudio();
    if (request !== padRequest) return;
    stopPad();
    musicLevel(.32);
    voice = buildPatch(ctx, item.patch, { destination:sfxGain, when:ctx.currentTime + .012, seed:item.seed, variant:0, trimDb:item.trimDb, scale:session.scale });
    $(`[data-pad="${index}"]`).classList.add('playing');
    voiceTimer = setTimeout(stopPad, (voice.end - ctx.currentTime + .06) * 1000);
    status(`${item.title} · synthesized live`);
    draw();
  } catch (error) { stopPad(); status(`Could not play this patch. ${error.message}`); }
}
let padRequest = 0;
function paint() {
  if (!session) return;
  const t = audio.currentTime;
  const fraction = Math.min(1, t / session.durationSec);
  $('#np-strip .played').style.width = `${fraction * 100}%`;
  $('#np-strip .head').style.left = `${fraction * 100}%`;
  $('#np-strip').setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  $('#np-strip').setAttribute('aria-valuetext', `${clock(t)} of ${clock(session.durationSec)}`);
  $('#pos').textContent = clock(t);
  let index = session.sections.findIndex(s => t >= s.start && t < s.end);
  if (index < 0) index = session.sections.length - 1;
  if (index !== sceneIndex) {
    sceneIndex = index;
    const [title, desc, tech] = sceneCopy[index];
    $('#scene-number').textContent = `SCENE ${String(index + 1).padStart(2,'0')} / ${clock(session.sections[index].start)}`;
    $('#scene-title').textContent = title;
    $('#scene-detail').textContent = desc;
    $('#scene-tech').textContent = tech;
    $('#np-title').textContent = `Matter / ${title}`;
    $('#np-desc').textContent = desc;
    $('#sec').textContent = title;
    document.querySelectorAll('[data-scene]').forEach(b => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.scene) === index));
    });
  }
}
function draw() {
  if (animation || document.hidden) return;
  const frame = () => {
    animation = 0;
    const canvas = $('#scope'), g = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    g.clearRect(0,0,w,h);
    g.strokeStyle = '#b5d4ce18'; g.lineWidth = 1;
    for(let y=30;y<h;y+=40) {g.beginPath();g.moveTo(0,y);g.lineTo(w,y);g.stroke();}
    const active = analyser && (!audio.paused || voice);
    if (active) {
      analyser.getByteFrequencyData(bins);
      const count=100;
      for(let i=0;i<count;i++) {
        const lo=Math.floor((40 * (400 ** (i/count))) / ctx.sampleRate * analyser.fftSize);
        const hi=Math.max(lo+1,Math.ceil((40 * (400 ** ((i+1)/count))) / ctx.sampleRate * analyser.fftSize));
        let peak=0; for(let b=lo;b<Math.min(hi,bins.length);b++)peak=Math.max(peak,bins[b]);
        const v=peak/255;
        g.fillStyle=i>74?'#ffae42':'#91c5ba';
        g.fillRect(i*w/count,h-v*(h-10),w/count-3,Math.max(1,v*(h-10)));
      }
      $('#meter-label').textContent = voice ? 'LIVE PATCH + OUTPUT' : 'REEL OUTPUT';
    } else {
      g.strokeStyle='#91c5ba55';g.beginPath();g.moveTo(0,h-2);g.lineTo(w,h-2);g.stroke();
      $('#meter-label').textContent='AWAITING SIGNAL';
    }
    if(active && !reducedMotion.matches) animation=requestAnimationFrame(frame);
  };
  frame();
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
      const button=document.createElement('button');button.className='toggle';button.dataset.scene=i;
      button.textContent=`${String(i+1).padStart(2,'0')} ${sceneCopy[i][0]}`;button.title=`Jump to ${clock(s.start)}`;
      button.onclick=()=>play(s.start);$('#chapters').append(button);
    });
    session.pads.forEach((p,i)=>{
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
    paint();draw();
  } catch(error) {status(`The session could not load. Reload the page to retry. ${error.message}`);$('#spec').textContent='Session unavailable';}
}
$('#play').onclick=()=>{if(audio.paused)void play();else{++playRequest;audio.pause();}};
$('#stop').onclick=()=>{++padRequest;stopAll();};
$('#prev').onclick=()=>play(session.sections[Math.max(0,sceneIndex-1)].start);
$('#next').onclick=()=>play(session.sections[(sceneIndex+1)%session.sections.length].start);
$('#repeat').onclick=e=>{audio.loop=!audio.loop;e.currentTarget.setAttribute('aria-pressed',String(audio.loop));};
$('#volume').oninput=e=>{if(master)master.gain.setTargetAtTime(Number(e.target.value)/100,ctx.currentTime,.02);};
audio.addEventListener('timeupdate',paint);
audio.addEventListener('play',()=>{$('#play').textContent='❚❚';$('#play').setAttribute('aria-label','Pause reel');$('#transport-state').textContent='Playing';$('#led').classList.add('on');});
audio.addEventListener('pause',()=>{$('#play').textContent='▶';$('#play').setAttribute('aria-label','Play reel');$('#transport-state').textContent=audio.ended?'Reel complete':'Paused';$('#led').classList.remove('on');});
audio.addEventListener('ended',()=>{$('#transport-state').textContent='Reel complete';draw();});
audio.addEventListener('error',()=>status('The audio could not load. Check your connection and press Play to retry.'));
audio.addEventListener('waiting',()=>{$('#transport-state').textContent='Buffering…';});
audio.addEventListener('playing',()=>{$('#transport-state').textContent='Playing';});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){++padRequest;stopAll();return;}
  if(e.target.closest('button,input,a,[role="slider"],summary')||e.repeat||e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.key===' '){e.preventDefault();$('#play').click();}
  if(/^[1-8]$/.test(e.key)){e.preventDefault();void strike(Number(e.key)-1);}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(animation);animation=0;}else draw();});
void load();
