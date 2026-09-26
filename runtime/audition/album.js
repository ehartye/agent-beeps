// Album page: streams each rendered song, loops loop songs on request, and records the owner's
// marks, tags and notes. Every track's strip is its measured loudness arc over its sections.

const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
};

const token = new URLSearchParams(location.search).get('t') ?? '';
const id = location.pathname.split('/').pop();
const api = (path, init = {}) => fetch(`${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`, init);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const SVGNS = 'http://www.w3.org/2000/svg';

let album = null, current = 0, repeat = 'album';
const audio = $('#audio');
const strips = new Map(); // track index -> [strip elements]

async function send(event) {
  const r = await api(`/api/album/${id}/event`, { method: 'POST', body: JSON.stringify(event), headers: { 'content-type': 'application/json' } });
  if (!r.ok) throw new Error((await r.json()).error?.message ?? r.statusText);
}

/** Section bands + loudness arc (−45..−5 LUFS mapped bottom to top) + playhead. */
function strip(track, big = false) {
  const el = h('div', { class: `strip${big ? ' big' : ''}` });
  const dur = track.durationSec;
  track.sections.forEach((s, i) => {
    const band = h('div', { class: 'band', style: `left:${(s.start / dur) * 100}%;width:${((s.end - s.start) / dur) * 100}%;background:var(--sec-${(i % 6) + 1})` });
    if (big || (s.end - s.start) / dur > 0.08) band.append(h('span', {}, s.name));
    el.append(band);
  });
  const arc = track.features.arc ?? [];
  if (arc.length > 1) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${arc.length} 100`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const pts = arc.map((v, i) => `${i + 0.5},${100 - ((Math.max(-45, Math.min(-5, v)) + 45) / 40) * 92 - 4}`).join(' ');
    const line = document.createElementNS(SVGNS, 'polyline');
    line.setAttribute('points', pts);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'var(--arc)');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
    el.append(svg);
  }
  el.append(h('div', { class: 'played' }), h('div', { class: 'head', style: 'left:0' }));
  const seek = e => {
    const r = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    play(track.index, frac * dur);
  };
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); seek(e); });
  el.addEventListener('pointermove', e => { if (e.buttons) seek(e); });
  if (!strips.has(track.index)) strips.set(track.index, []);
  strips.get(track.index).push(el);
  return el;
}

function paintHead() {
  const t = album?.tracks.find(x => x.index === current);
  if (!t) return;
  const frac = audio.duration ? audio.currentTime / audio.duration : 0;
  for (const [index, els] of strips) for (const el of els) {
    const f = index === current ? frac : 0;
    el.querySelector('.played').style.width = `${f * 100}%`;
    el.querySelector('.head').style.left = `${f * 100}%`;
  }
  $('#pos').textContent = mmss(audio.currentTime || 0);
  $('#dur').textContent = mmss(t.durationSec);
  const sec = t.sections.find(s => audio.currentTime >= s.start && audio.currentTime < s.end);
  $('#sec').textContent = sec ? sec.name : '';
  $('#np-strip').setAttribute('aria-valuenow', String(Math.round(frac * 100)));
}

let npEl = null;
function nowPlaying(t) {
  $('#np-title').textContent = t.title;
  $('#np-desc').textContent = t.description ?? '';
  // The big strip mirrors whatever is playing: rebuild it and register it under this track.
  if (npEl) for (const [k, els] of strips) strips.set(k, els.filter(e => e !== npEl));
  const el = strip(t, true);
  el.id = 'np-strip';
  for (const [k, v] of Object.entries({ role: 'slider', 'aria-label': 'Seek', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' })) el.setAttribute(k, v);
  $('#np-strip').replaceWith(el);
  npEl = el;
  document.querySelectorAll('.track').forEach(li => li.dataset.playing = String(Number(li.dataset.index) === t.index));
}

let played = new Set();
function play(index, at = 0) {
  const t = album.tracks.find(x => x.index === index);
  if (!t) return;
  if (current !== index || !audio.src) {
    current = index;
    audio.src = `${t.wav}?t=${encodeURIComponent(token)}`;
    nowPlaying(t);
    if (!played.has(index)) { played.add(index); send({ type: 'play', index }).catch(() => {}); }
  }
  audio.loop = repeat === 'track';
  const go = () => { audio.currentTime = at; audio.play().catch(() => {}); };
  if (audio.readyState >= 1) go(); else audio.addEventListener('loadedmetadata', go, { once: true });
}

function step(d) {
  const i = album.tracks.findIndex(x => x.index === current);
  const next = album.tracks[(i + d + album.tracks.length) % album.tracks.length];
  play(next.index);
}

function saver(el, event, status) {
  let timer = null;
  el.addEventListener('input', () => {
    clearTimeout(timer);
    status.textContent = '';
    timer = setTimeout(() => send(event()).then(() => { status.textContent = 'Saved'; }).catch(e => { status.textContent = `Not saved: ${e.message}`; }), 700);
  });
}

function trackCard(t, state) {
  const s = state.tracks.find(x => x.index === t.index);
  const f = t.features;
  const facts = [mmss(t.durationSec), t.loop ? 'loops' : 'plays once', `${f.loudnessLufs ?? '–'} LUFS`, `range ${f.loudnessRangeLu ?? '–'} LU`].join(' · ');
  const verdict = h('div', { class: 'verdict', role: 'group', 'aria-label': `Verdict on ${t.title}` });
  for (const [mark, label] of [['love', 'Love'], ['keep', 'Keep'], ['dud', 'Dud']]) {
    verdict.append(h('button', {
      'data-mark': mark, 'aria-pressed': String(s.mark === mark),
      onclick: async e => {
        const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
        await send({ type: 'mark', index: t.index, mark: on ? mark : null });
        verdict.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(on && b.dataset.mark === mark)));
      },
    }, label));
  }
  const tags = new Set(s.tags);
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Tags' }, album.tags.map(tag => h('button', {
    'aria-pressed': String(tags.has(tag)),
    onclick: async e => {
      if (tags.has(tag)) tags.delete(tag); else tags.add(tag);
      e.currentTarget.setAttribute('aria-pressed', String(tags.has(tag)));
      await send({ type: 'tags', index: t.index, tags: [...tags] });
    },
  }, tag)));
  const note = h('textarea', { rows: 2, placeholder: 'What works, what to change', 'aria-label': `Notes on ${t.title}` });
  note.value = s.note;
  const status = h('div', { class: 'saved', 'aria-live': 'polite' });
  saver(note, () => ({ type: 'note', index: t.index, text: note.value }), status);
  return h('li', { class: 'track', 'data-index': t.index },
    h('div', { class: 'no' }, String(t.index).padStart(2, '0')),
    h('div', { class: 'body' },
      h('div', { class: 'row' },
        h('h2', {}, h('button', { onclick: () => play(t.index), title: 'Play from the start' }, t.title)),
        h('span', { class: 'facts' }, facts)),
      t.description ? h('p', { class: 'desc' }, t.description) : null,
      strip(t),
      h('div', { class: 'row' }, verdict),
      chips,
      note, status,
      h('details', { class: 'look' }, h('summary', {}, 'What the agent saw'), h('img', { loading: 'lazy', alt: `Waveform, loudness arc and spectrogram of ${t.title}`, src: `${t.look}?t=${encodeURIComponent(token)}` }))));
}

async function load() {
  const r = await api(`/api/album/${id}`);
  if (!r.ok) {
    $('#title').textContent = 'Album unavailable';
    $('#tracks').replaceChildren(h('li', { class: 'error' }, r.status === 401 ? 'This page needs the full link with its ?t= token. Ask the agent for the album link.' : 'This album is not on this server. Ask the agent to open it again.'));
    return;
  }
  album = await r.json();
  document.title = `${album.title} · agent-beeps`;
  $('#title').textContent = album.title;
  const total = album.tracks.reduce((a, t) => a + t.durationSec, 0);
  $('#meta').textContent = `${album.tracks.length} tracks · ${mmss(total)} · ${new Date(album.createdAt).toLocaleDateString()}`;
  $('#tracks').replaceChildren(...album.tracks.map(t => trackCard(t, album.state)));
  $('#album-note').value = album.state.note;
  saver($('#album-note'), () => ({ type: 'note', text: $('#album-note').value }), $('#album-saved'));
  current = album.tracks[0].index;
  nowPlaying(album.tracks[0]);
}

$('#play').addEventListener('click', () => {
  if (!audio.src) return play(current);
  if (audio.paused) audio.play(); else audio.pause();
});
$('#prev').addEventListener('click', () => step(-1));
$('#next').addEventListener('click', () => step(1));
document.querySelectorAll('[data-repeat]').forEach(b => b.addEventListener('click', () => {
  repeat = b.dataset.repeat;
  document.querySelectorAll('[data-repeat]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  audio.loop = repeat === 'track';
}));
$('#seam').addEventListener('click', () => {
  const t = album.tracks.find(x => x.index === current);
  document.querySelector('[data-repeat="track"]').click();
  play(current, Math.max(0, t.durationSec - 8));
});
document.addEventListener('keydown', e => {
  if (!(e.target instanceof HTMLElement) || e.target.id !== 'np-strip') return;
  if (e.key === 'ArrowRight') audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
  if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
});
audio.addEventListener('timeupdate', paintHead);
audio.addEventListener('play', () => { $('#play').textContent = '❚❚'; $('#play').setAttribute('aria-label', 'Pause'); });
audio.addEventListener('pause', () => { $('#play').textContent = '▶'; $('#play').setAttribute('aria-label', 'Play'); });
audio.addEventListener('ended', () => { if (repeat === 'album') step(1); });
document.addEventListener('keydown', e => {
  if (e.target instanceof HTMLTextAreaElement) return;
  if (e.key === ' ') { e.preventDefault(); $('#play').click(); }
  if (e.key === 'n') step(1);
  if (e.key === 'p') step(-1);
});

load();
