// The playlists page: three sets read from tracks.json, one shared audio element and a live spectrum monitor, no dependencies.
const $ = id => document.getElementById(id);
const audio = $('audio');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const fmt = s => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage can be blocked; the page works without it */ } },
};

const REPEAT = ['off', 'all', 'one'];
const state = { data: null, setId: null, playingSet: null, index: -1, repeat: store.get('repeat', 'off') };
const setById = id => state.data.sets.find(s => s.id === id);
const nowTrack = () => (state.index >= 0 ? setById(state.playingSet)?.tracks[state.index] : null);

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) e.append(k);
  return e;
}

// --- Output monitor: the booth's 100 log-spaced bars from 40 Hz up, read from an analyser on the audio element. ---
let ctx, analyser, bins, raf = 0;
function ensureAudioGraph() {
  if (ctx) return;
  try {
    ctx = new AudioContext();
    const source = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.78;
    bins = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser).connect(ctx.destination);
  } catch { ctx = analyser = null; }
}

function paintScope() {
  const canvas = $('scope'), g = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  g.clearRect(0, 0, w, h); g.strokeStyle = '#b5d4ce18'; g.lineWidth = 1;
  for (let y = 30; y < h; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  const active = analyser && ctx.state === 'running' && !audio.paused;
  if (active) {
    analyser.getByteFrequencyData(bins); const count = 100;
    for (let i = 0; i < count; i++) {
      const lo = Math.floor((40 * (400 ** (i / count))) / ctx.sampleRate * analyser.fftSize);
      const hi = Math.max(lo + 1, Math.ceil((40 * (400 ** ((i + 1) / count))) / ctx.sampleRate * analyser.fftSize));
      let peak = 0; for (let b = lo; b < Math.min(hi, bins.length); b++) peak = Math.max(peak, bins[b]);
      const v = peak / 255; g.fillStyle = i > 74 ? '#ffae42' : '#91c5ba';
      g.fillRect(i * w / count, h - v * (h - 10), w / count - 3, Math.max(1, v * (h - 10)));
    }
    $('meter-label').textContent = `${setById(state.playingSet).title.toUpperCase()} / OUTPUT`;
  } else {
    g.strokeStyle = '#91c5ba55'; g.beginPath(); g.moveTo(0, h - 2); g.lineTo(w, h - 2); g.stroke();
    $('meter-label').textContent = nowTrack() && audio.paused ? 'SIGNAL PAUSED' : analyser || !nowTrack() ? 'AWAITING SIGNAL' : 'NO SPECTRUM IN THIS BROWSER';
  }
  return active;
}
function frame() { raf = 0; if (paintScope() && !reducedMotion.matches && !document.hidden) raf = requestAnimationFrame(frame); }
const drawScope = () => { if (!raf) frame(); };
document.addEventListener('visibilitychange', drawScope);

// --- Rendering ---
function renderTabs() {
  $('tabs').replaceChildren(...state.data.sets.map(s => el('button', {
    type: 'button', class: 'toggle', 'aria-pressed': String(s.id === state.setId), id: `tab-${s.id}`, onclick: () => selectSet(s.id),
  }, el('b', {}, s.title), el('small', {}, `${s.tracks.length} TRACKS / ${fmt(s.tracks.reduce((a, t) => a + t.durationSec, 0))}`))));
}

function renderIntro() {
  const s = setById(state.setId);
  const right = el('div', {}, ...s.brief.map(p => el('p', {}, p)),
    el('details', {}, el('summary', {}, 'Where the numbers come from'),
      el('ul', {}, ...s.sources.map(x => el('li', {}, el('a', { href: x.url, rel: 'noopener' }, x.label))))));
  $('intro').replaceChildren(el('p', { class: 'lede' }, s.tagline), right);
}

function renderTracks() {
  const s = setById(state.setId);
  $('tracks').replaceChildren(...s.tracks.map((t, i) => {
    const playing = state.playingSet === s.id && state.index === i;
    return el('li', { class: 'track', id: `t-${t.id}`, 'data-playing': String(playing) },
      el('button', { class: 'play', type: 'button', 'aria-label': `Play ${t.title}`, onclick: () => play(s.id, i) }, '▶'),
      el('div', { class: 'body' },
        el('div', { class: 'row' }, el('h2', {}, el('button', { type: 'button', onclick: () => play(s.id, i) }, t.title)),
          el('span', { class: 'facts' }, `${String(i + 1).padStart(2, '0')} / ${t.bpm} BPM / ${fmt(t.durationSec)}`)),
        el('p', { class: 'desc' }, t.description),
        el('div', { class: 'links' }, el('a', { href: t.recipe }, 'Score (JSON) ↗')),
        el('details', { class: 'look' }, el('summary', {}, 'Show the sound'), el('img', { src: t.look, alt: `Waveform, loudness arc and spectrogram of ${t.title}`, loading: 'lazy' }))));
  }));
}

function mark() {
  document.querySelectorAll('.track').forEach(li => li.setAttribute('data-playing', String(li.id === `t-${nowTrack()?.id}`)));
}

function paintTransport() {
  const t = nowTrack(), playing = !audio.paused;
  $('np-title').textContent = t ? t.title : 'Pick a track';
  $('np-desc').textContent = t ? `${setById(state.playingSet).title} · ${t.bpm} bpm` : 'Press play on any track below.';
  $('transport-state').textContent = !t ? 'Ready when you are' : playing ? 'Playing' : 'Paused';
  $('led').classList.toggle('on', playing);
  $('play').textContent = playing ? '⏸' : '▶';
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('sec').textContent = t ? setById(state.playingSet).title.toUpperCase() : '';
  const look = $('strip-look');
  if (t) { if (look.getAttribute('src') !== t.look) look.src = t.look; look.alt = `Waveform and spectrogram of ${t.title}`; look.hidden = false; } else look.hidden = true;
}

function paintPosition() {
  const d = audio.duration || nowTrack()?.durationSec || 0, f = d ? Math.min(1, audio.currentTime / d) : 0;
  $('pos').textContent = fmt(audio.currentTime); $('dur').textContent = fmt(d);
  $('strip-played').style.width = `${f * 100}%`; $('strip-head').style.left = `calc(${f * 100}% - 1px)`;
  $('strip').setAttribute('aria-valuenow', String(Math.round(f * 100)));
}

function selectSet(id) {
  state.setId = id; renderTabs(); renderIntro(); renderTracks();
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  document.title = `${setById(id).title} · Three Playlists · agent-beeps`;
}

function play(setId, i) {
  const t = setById(setId).tracks[i]; if (!t) return;
  state.playingSet = setId; state.index = i;
  ensureAudioGraph(); ctx?.resume();
  if (!audio.src.endsWith(t.mp3.replace('./', ''))) audio.src = t.mp3;
  audio.play().catch(() => { $('status').textContent = 'The browser blocked playback; press play again.'; });
  mark(); paintTransport();
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: 'agent-beeps', album: setById(setId).title });
}

function step(d) {
  const set = setById(state.playingSet ?? state.setId), n = set.tracks.length; if (!n) return;
  const next = (state.index < 0 ? -1 : state.index) + d;
  if (next < 0) return play(set.id, 0);
  if (next >= n) { if (state.repeat === 'all') return play(set.id, 0); audio.pause(); audio.currentTime = 0; return; }
  play(set.id, next);
}

function setRepeat(mode) {
  state.repeat = mode; store.set('repeat', mode);
  const b = $('repeat'); b.textContent = `Repeat ${mode}`; b.setAttribute('aria-label', `Repeat: ${mode}`); b.setAttribute('aria-pressed', String(mode !== 'off'));
}

// --- Wiring ---
audio.addEventListener('ended', () => state.repeat === 'one' ? play(state.playingSet, state.index) : step(1));
audio.addEventListener('timeupdate', () => { paintPosition(); if (reducedMotion.matches) drawScope(); });
audio.addEventListener('loadedmetadata', paintPosition);
audio.addEventListener('play', () => { paintTransport(); drawScope(); });
audio.addEventListener('pause', () => { paintTransport(); drawScope(); });
$('play').addEventListener('click', () => { if (state.index < 0) play(state.setId, 0); else if (audio.paused) { ctx?.resume(); audio.play(); } else audio.pause(); });
$('prev').addEventListener('click', () => audio.currentTime > 3 ? (audio.currentTime = 0) : step(-1));
$('next').addEventListener('click', () => step(1));
$('stop').addEventListener('click', () => { audio.pause(); audio.currentTime = 0; paintTransport(); paintPosition(); });
$('repeat').addEventListener('click', () => setRepeat(REPEAT[(REPEAT.indexOf(state.repeat) + 1) % REPEAT.length]));
$('volume').addEventListener('input', e => { audio.volume = e.target.value / 100; store.set('volume', e.target.value); });

const strip = $('strip');
const seek = e => { const d = audio.duration; if (!d) return; const r = strip.getBoundingClientRect(); audio.currentTime = d * Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
strip.addEventListener('pointerdown', e => { strip.setPointerCapture(e.pointerId); seek(e); });
strip.addEventListener('pointermove', e => { if (strip.hasPointerCapture(e.pointerId)) seek(e); });
strip.addEventListener('keydown', e => {
  if (!audio.duration) return;
  const by = { ArrowLeft: -5, ArrowRight: 5, Home: -Infinity, End: Infinity }[e.key]; if (by === undefined) return;
  e.preventDefault(); audio.currentTime = Math.min(audio.duration, Math.max(0, by === -Infinity ? 0 : by === Infinity ? audio.duration : audio.currentTime + by));
});

window.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space' && !e.target.matches('button, a, summary, [role=slider]')) { e.preventDefault(); $('play').click(); }
  else if (e.key === 'Escape') $('stop').click();
  else if (e.code === 'ArrowRight' && e.shiftKey) step(1);
  else if (e.code === 'ArrowLeft' && e.shiftKey) step(-1);
});
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
}
window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (state.data?.sets.some(s => s.id === id)) selectSet(id); });

const volume = Number(store.get('volume', '80')); $('volume').value = String(volume); audio.volume = volume / 100;
setRepeat(REPEAT.includes(state.repeat) ? state.repeat : 'off');

try {
  state.data = await (await fetch('./tracks.json')).json();
  const wanted = location.hash.slice(1);
  selectSet(state.data.sets.some(s => s.id === wanted) ? wanted : state.data.sets[0].id);
  paintTransport(); paintPosition(); drawScope();
} catch (e) {
  $('intro').textContent = `The playlists could not be loaded (${e.message}).`;
}
