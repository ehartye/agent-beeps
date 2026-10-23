// The playlist page: three sets of tracks read from tracks.json, one shared audio element, no dependencies.
const $ = id => document.getElementById(id);
const audio = $('audio');
const fmt = s => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage can be blocked; the page works without it */ } },
};

const state = { data: null, setId: null, index: -1, repeat: store.get('repeat', 'off') };
const current = () => state.data.sets.find(s => s.id === state.setId);
const REPEAT = ['off', 'all', 'one'];

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); }
  for (const k of kids) e.append(k);
  return e;
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren(...state.data.sets.map(s => el('button', {
    type: 'button', role: 'tab', 'aria-selected': String(s.id === state.setId), id: `tab-${s.id}`, onclick: () => selectSet(s.id),
  }, el('strong', {}, s.title), el('span', {}, `${s.tracks.length} tracks · ${fmt(s.tracks.reduce((a, t) => a + t.durationSec, 0))}`))));
}

function renderIntro() {
  const s = current();
  const intro = $('intro');
  intro.replaceChildren(el('p', { class: 'tagline' }, s.tagline), ...s.brief.map(p => el('p', {}, p)),
    el('details', {}, el('summary', {}, 'Where the numbers come from'),
      el('ul', {}, ...s.sources.map(x => el('li', {}, el('a', { href: x.url, rel: 'noopener' }, x.label))))));
}

function renderTracks() {
  const s = current();
  $('tracks').replaceChildren(...s.tracks.map((t, i) => {
    const look = el('img', { class: 'look', src: t.look, alt: `Waveform, loudness arc and spectrogram of ${t.title}`, loading: 'lazy', hidden: true });
    const toggle = el('button', { type: 'button', 'aria-expanded': 'false', onclick: ev => {
      look.hidden = !look.hidden; ev.target.setAttribute('aria-expanded', String(!look.hidden)); ev.target.textContent = look.hidden ? 'Show the sound' : 'Hide the sound';
    } }, 'Show the sound');
    return el('li', { class: 'track', id: `t-${t.id}`, 'aria-current': String(i === state.index) },
      el('button', { class: 'num', type: 'button', 'aria-label': `Play ${t.title}`, onclick: () => play(i) }, '▶'),
      el('div', {},
        el('h3', {}, t.title),
        el('div', { class: 'meta' }, `${t.bpm} bpm · ${fmt(t.durationSec)}`),
        el('p', {}, t.description),
        el('div', { class: 'links' }, toggle, el('a', { href: t.recipe }, 'score (JSON)')),
        look));
  }));
}

function mark() {
  document.querySelectorAll('.track').forEach((li, i) => li.setAttribute('aria-current', String(i === state.index)));
}

function selectSet(id, { keepPlaying = true } = {}) {
  state.setId = id; document.body.dataset.set = id;
  if (!keepPlaying || audio.paused) state.index = -1;
  renderTabs(); renderIntro(); renderTracks();
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  document.title = `${current().title} · Three Playlists`;
}

function play(i) {
  const s = current(), t = s.tracks[i];
  if (!t) return;
  state.index = i;
  if (!audio.src.endsWith(t.mp3.replace('./', ''))) audio.src = t.mp3;
  audio.play().catch(() => { /* a blocked autoplay leaves the play button to try again */ });
  $('dock').hidden = false;
  $('dock-title').textContent = t.title; $('dock-sub').textContent = `${s.title} · ${t.bpm} bpm`;
  $('dock-look').src = t.look;
  mark();
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: 'agent-beeps', album: s.title });
}

const step = d => {
  const n = current().tracks.length; if (!n) return;
  const next = state.index + d;
  if (next < 0) return play(0);
  if (next >= n) return state.repeat === 'all' ? play(0) : (audio.pause(), audio.currentTime = 0);
  play(next);
};

function setRepeat(mode) {
  state.repeat = mode; store.set('repeat', mode);
  const b = $('repeat'); b.textContent = `Repeat ${mode}`; b.setAttribute('aria-label', `Repeat: ${mode}`); b.title = `Repeat: ${mode}`;
}

audio.addEventListener('ended', () => state.repeat === 'one' ? play(state.index) : step(1));
audio.addEventListener('timeupdate', () => { $('cur').textContent = fmt(audio.currentTime); if (audio.duration) $('seek').value = String(Math.round(1000 * audio.currentTime / audio.duration)); });
audio.addEventListener('loadedmetadata', () => { $('dur').textContent = fmt(audio.duration); });
audio.addEventListener('play', () => { $('play').textContent = '⏸'; $('play').setAttribute('aria-label', 'Pause'); });
audio.addEventListener('pause', () => { $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'Play'); });
$('play').addEventListener('click', () => { if (state.index < 0) play(0); else if (audio.paused) audio.play(); else audio.pause(); });
$('prev').addEventListener('click', () => audio.currentTime > 3 ? (audio.currentTime = 0) : step(-1));
$('next').addEventListener('click', () => step(1));
$('seek').addEventListener('input', e => { if (audio.duration) audio.currentTime = audio.duration * e.target.value / 1000; });
$('vol').addEventListener('input', e => { audio.volume = e.target.value / 100; store.set('volume', e.target.value); });
$('repeat').addEventListener('click', () => setRepeat(REPEAT[(REPEAT.indexOf(state.repeat) + 1) % REPEAT.length]));
window.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space' && !e.target.matches('button, a')) { e.preventDefault(); $('play').click(); }
  else if (e.code === 'ArrowRight' && e.shiftKey) step(1);
  else if (e.code === 'ArrowLeft' && e.shiftKey) step(-1);
});
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
}
window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (state.data?.sets.some(s => s.id === id)) selectSet(id); });

const volume = Number(store.get('volume', '80')); $('vol').value = String(volume); audio.volume = volume / 100;
setRepeat(REPEAT.includes(state.repeat) ? state.repeat : 'off');

try {
  state.data = await (await fetch('./tracks.json')).json();
  const wanted = location.hash.slice(1);
  selectSet(state.data.sets.some(s => s.id === wanted) ? wanted : state.data.sets[0].id, { keepPlaying: false });
} catch (e) {
  $('intro').textContent = `The playlists could not be loaded (${e.message}).`;
}
