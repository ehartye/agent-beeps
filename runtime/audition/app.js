// The listening booth. Plays candidates live through the same engine the CLI measured, at their
// measured loudness trims, and records only explicit judgements as verdicts.
import { buildPatch } from '../engine/patch.js';
import { createPicker } from '../engine/variation.js';

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

const params = new URLSearchParams(location.search);
const token = params.get('t') ?? '';
const id = location.pathname.split('/').pop();
const api = (path, init = {}) => fetch(`${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`, init);

let data = null;          // latest session payload
let lastPlayed = null;    // index, for H / X shortcuts
const marks = new Map();  // lineup: index -> 'love' | 'dud'
let duelSides = null;     // { left, right } after randomising
const whyTags = new Set();
const directions = new Set();
let pollTimer = null;

// ---------- audio ----------
let ctx = null, master = null, speaker = null, analyser = null, playGroup = null, bedTimer = null, bedGain = null;
const pickers = new Map();
const SPEAKERS = {
  full: [],
  laptop: [{ type: 'highpass', frequency: 180, Q: 0.7 }, { type: 'lowpass', frequency: 14000, Q: 0.7 }],
  phone: [{ type: 'highpass', frequency: 450, Q: 0.9 }, { type: 'peaking', frequency: 2500, Q: 1, gain: 4 }, { type: 'lowpass', frequency: 9000, Q: 0.7 }],
};
let speakerMode = 'full', repeat = 1, withKit = false, withBed = false;

function audio() {
  if (ctx) return ctx;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  master = ctx.createGain();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  speaker = ctx.createGain();
  master.connect(speaker);
  setSpeaker(speakerMode);
  return ctx;
}

function setSpeaker(mode) {
  speakerMode = mode;
  if (!ctx) return;
  speaker.disconnect();
  let node = speaker;
  for (const f of SPEAKERS[mode]) {
    const b = ctx.createBiquadFilter();
    b.type = f.type; b.frequency.value = f.frequency; b.Q.value = f.Q; if (f.gain) b.gain.value = f.gain;
    node.connect(b); node = b;
  }
  node.connect(analyser);
  analyser.connect(ctx.destination);
}

function stopAll() {
  if (playGroup) { playGroup.gain.setTargetAtTime(0, ctx.currentTime, 0.01); const g = playGroup; setTimeout(() => g.disconnect(), 200); playGroup = null; }
  document.querySelectorAll('.pad.playing').forEach(p => p.classList.remove('playing'));
  $('#led').classList.remove('on');
}

function candidate(index) { return data.candidates.find(c => c.index === index); }

function playPatch(patch, trimDb, when, seed, group, kind = 'candidate') {
  const key = `${kind}:${patch.name}`; // a kit sound and a candidate may share a name
  if (!pickers.has(key)) pickers.set(key, createPicker(patch, seed));
  const variant = pickers.get(key).next();
  return buildPatch(ctx, patch, { destination: group, when, seed, variant, trimDb, scale: data.scale });
}

/** Play a candidate: once, ×5 at 0.4 s, or ×75, optionally interleaved with the kit. */
async function play(index, { count = repeat, pad = null } = {}) {
  audio();
  if (ctx.state !== 'running') await ctx.resume();
  stopAll();
  const c = candidate(index);
  lastPlayed = index;
  playGroup = ctx.createGain();
  playGroup.connect(master);
  const kit = withKit ? data.kit : [];
  let t = ctx.currentTime + 0.05;
  let end = t;
  for (let i = 0; i < count; i++) {
    if (kit.length) {
      const k = kit[i % kit.length];
      end = Math.max(end, playPatch(k.patch, k.trimDb, t, k.seed ?? 1, playGroup, 'kit').end);
      t += 0.5;
    }
    end = Math.max(end, playPatch(c.patch, c.trimDb, t, c.seed ?? 1, playGroup).end);
    t += 0.4;
  }
  const el = pad ?? document.querySelector(`.pad[data-index="${index}"]`);
  if (el) { el.classList.add('playing'); scope(el, end); }
  $('#led').classList.add('on');
  const g = playGroup;
  setTimeout(() => { if (playGroup === g) { el?.classList.remove('playing'); $('#led').classList.remove('on'); } }, (end - ctx.currentTime) * 1000 + 50);
  send({ type: 'play', index, mode: `${count}${withKit ? '+kit' : ''}` }, true);
}

/** Live oscilloscope sweeping across the pad's spectrogram face while it sounds. */
function scope(pad, end) {
  const canvas = pad.querySelector('canvas');
  if (!canvas || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const g = canvas.getContext('2d');
  const buf = new Float32Array(analyser.fftSize);
  const draw = () => {
    const w = canvas.width = canvas.clientWidth * devicePixelRatio, hgt = canvas.height = canvas.clientHeight * devicePixelRatio;
    g.clearRect(0, 0, w, hgt);
    if (!ctx || ctx.currentTime > end || !pad.classList.contains('playing')) return;
    analyser.getFloatTimeDomainData(buf);
    g.strokeStyle = 'rgba(255,255,255,.92)';
    g.lineWidth = 2 * devicePixelRatio;
    g.beginPath();
    for (let i = 0; i < buf.length; i += 4) {
      const x = (i / buf.length) * w, y = hgt / 2 - buf[i] * hgt * 0.9;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

function setBed(on) {
  withBed = on;
  clearInterval(bedTimer);
  if (bedGain) { const g = bedGain; g.gain.setTargetAtTime(0, ctx.currentTime, 0.2); setTimeout(() => g.disconnect(), 1500); bedGain = null; }
  if (!on || !data.bed) return;
  audio();
  ctx.resume();
  bedGain = ctx.createGain();
  bedGain.gain.value = 0.35;
  bedGain.connect(master);
  const loop = () => buildPatch(ctx, data.bed, { destination: bedGain, when: ctx.currentTime + 0.05, trimDb: -12, limiter: false });
  loop();
  bedTimer = setInterval(loop, (data.bed.duration - 0.4) * 1000);
}

// ---------- server ----------
async function load() {
  const r = await api(`/api/session/${id}`);
  if (!r.ok) { fail((await r.json()).error?.message ?? `HTTP ${r.status}`); return; }
  data = await r.json();
  render();
}

let posting = false;
async function send(event, quiet = false) {
  if (!quiet) {
    if (posting) return; // one judgement at a time: a double tap must not record twice
    posting = true;
    document.querySelectorAll('#stage button').forEach(b => { b.disabled = true; });
  }
  try { return await post(event, quiet); } finally { if (!quiet) posting = false; }
}

async function post(event, quiet) {
  const r = await api(`/api/session/${id}/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
  if (quiet) return;
  if (!r.ok) { toast((await r.json()).error?.message ?? 'That did not save'); await load(); return; }
  await load();
}

function fail(message) {
  $('#stage').replaceChildren(h('div', { class: 'error' }, `This audition could not load: ${message}. Check the link still has its ?t= token.`));
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- views ----------
function padFor(c, { marksOn = false, label = String(c.index) } = {}) {
  const pad = h('article', { class: 'pad', 'data-index': c.index });
  const face = h('button', { class: 'face', 'aria-label': `Play ${label}`, onclick: () => play(c.index, { pad }) },
    h('img', { src: `${c.look}?t=${encodeURIComponent(token)}`, alt: '' }), h('canvas'), h('span', { class: 'key' }, label));
  pad.append(face, h('div', { class: 'words' }, c.words.map(w => h('span', { class: 'word' }, w))));
  if (marksOn) {
    const m = marks.get(c.index);
    if (m) pad.classList.add(m);
    const setMark = kind => { marks.get(c.index) === kind ? marks.delete(c.index) : marks.set(c.index, kind); render(); };
    pad.append(h('div', { class: 'marks' },
      h('button', { class: 'mark heart', 'aria-pressed': m === 'love', onclick: () => setMark('love') }, '♥ Keep'),
      h('button', { class: 'mark x', 'aria-pressed': m === 'dud', onclick: () => setMark('dud') }, '✗ Dud')));
  }
  return pad;
}

function lineupView(s) {
  const onOffer = s.lineup.map(candidate);
  const pinned = s.round > 0 ? s.champion : null;
  const loved = [...marks].filter(([, v]) => v === 'love').map(([k]) => k);
  const duds = [...marks].filter(([, v]) => v === 'dud').map(([k]) => k);
  return [
    h('p', { class: 'hint' }, s.round === 0
      ? 'Tap a pad to hear it. Keep the two or three you like, mark the duds, then duel your keepers.'
      : `Round ${s.round}: new variations against your champion (#${pinned}). Keep the ones worth a duel.`),
    h('div', { class: 'pads' }, onOffer.map(c => padFor(c, { marksOn: c.index !== pinned, label: c.index === pinned ? `${c.index} ★` : String(c.index) }))),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', onclick: () => { send({ type: 'lineup', loved, duds }); marks.clear(); } },
        loved.length ? `Duel my ${loved.length} keeper${loved.length > 1 ? 's' : ''}` : 'Duel the rest'),
      h('span', { class: 'hint' }, `${loved.length} kept · ${duds.length} dud · plays are never counted as votes`),
      h('button', { class: 'secondary', onclick: () => { if (confirm('Close this audition without choosing? The agent will see it was closed.')) send({ type: 'abandon' }); } }, 'None of these')),
  ];
}

function duelView() {
  const [a, b] = data.next;
  if (!duelSides || duelSides.key !== `${a}-${b}`) {
    const flip = Math.random() < 0.5; // randomise sides: position bias is real
    duelSides = { key: `${a}-${b}`, left: flip ? b : a, right: flip ? a : b, position: flip ? 'ba' : 'ab' };
    whyTags.clear();
  }
  const L = candidate(duelSides.left), R = candidate(duelSides.right);
  const decide = outcome => {
    // Map left/right back onto the server's a/b.
    const map = { left: duelSides.left === a ? 'a' : 'b', right: duelSides.right === a ? 'a' : 'b' };
    const o = outcome === 'left' ? map.left : outcome === 'right' ? map.right : outcome;
    send({ type: 'duel', a, b, outcome: o, tags: [...whyTags], position: duelSides.position });
    duelSides = null;
  };
  const TAGS = ['brighter', 'darker', 'punchier', 'softer', 'shorter', 'longer', 'less harsh', 'more character'];
  return [
    h('p', { class: 'hint' }, 'Which one fits better? Space plays left then right.'),
    h('div', { class: 'duel' }, padFor(L, { label: 'Left' }), h('div', { class: 'vs' }, 'vs'), padFor(R, { label: 'Right' })),
    h('div', { class: 'verdicts' },
      h('button', { onclick: () => decide('left') }, '← Left', h('kbd', {}, '←')),
      h('button', { onclick: () => decide('tie') }, 'Same', h('kbd', {}, '↓')),
      h('button', { onclick: () => decide('bothBad') }, 'Both bad', h('kbd', {}, '↑')),
      h('button', { onclick: () => decide('right') }, 'Right →', h('kbd', {}, '→'))),
    h('div', { class: 'why', 'aria-label': 'Why (optional): the winner is…' }, h('span', { class: 'hint' }, 'The winner is'),
      TAGS.map(t => h('button', { class: 'chip', 'aria-pressed': whyTags.has(t), onclick: () => { whyTags.has(t) ? whyTags.delete(t) : whyTags.add(t); render(); } }, t))),
  ];
}

function refineView(s) {
  const champ = s.champion != null ? candidate(s.champion) : null;
  if (!champ) return [h('p', { class: 'hint' }, 'No champion yet.')];
  const DIRS = ['brighter', 'darker', 'punchier', 'softer', 'shorter', 'longer', 'less-harsh', 'more-character'];
  const others = data.candidates.filter(c => c.index !== s.champion);
  let like = null;
  const shipName = h('input', { class: 'secondary', placeholder: 'name (optional)', pattern: '[a-z0-9][a-z0-9-]*', 'aria-label': 'Name for the shipped sound' });
  return [
    s.lastError ? h('div', { class: 'error' }, `The last refine did not work: ${s.lastError}. Try other directions, or ship.`) : null,
    h('div', { class: 'bench' },
      h('div', {}, h('h2', {}, `Champion #${champ.index}`), padFor(champ, { label: `${champ.index} ★` })),
      h('div', {},
        h('h2', {}, 'Nudge it'),
        h('p', { class: 'hint' }, 'Pick up to four directions and the next round will be variations of the champion that move that way.'),
        h('div', { class: 'why' }, DIRS.map(d => h('button', { class: 'chip', 'aria-pressed': directions.has(d), onclick: () => { directions.has(d) ? directions.delete(d) : directions.size < 4 && directions.add(d); render(); } }, d.replace('-', ' ')))),
        others.length ? h('div', { class: 'why' }, h('span', { class: 'hint' }, 'More like'),
          others.slice(-8).map(c => h('button', { class: 'chip', onclick: () => { like = c.index; send({ type: 'refine', champion: champ.index, directions: [...directions], like }); directions.clear(); } }, `#${c.index}`))) : null,
        h('div', { class: 'actions' },
          h('button', { class: 'secondary', disabled: directions.size === 0, onclick: () => { send({ type: 'refine', champion: champ.index, directions: [...directions], like: null }); directions.clear(); } }, 'Breed variations'),
          h('button', { class: 'secondary', onclick: () => send({ type: 'refine', champion: champ.index, directions: ['surprise'], like: null }) }, 'Surprise me')),
        h('h2', { style: 'margin-top:26px' }, 'Or ship it'),
        h('div', { class: 'actions' }, shipName,
          h('button', { class: 'primary', onclick: () => {
            const name = shipName.value.trim();
            if (name && !/^[a-z0-9][a-z0-9-]*$/.test(name)) { toast('Names use lowercase letters, digits and dashes'); return; }
            send({ type: 'ship', champion: champ.index, ...(name ? { name } : {}) });
          } }, `Ship #${champ.index}`)))),
  ];
}

function waitingView(s) {
  const champ = s.champion != null ? candidate(s.champion) : null;
  return [h('div', { class: 'waiting' }, h('span', { class: 'led on' }),
    `Breeding variations of #${s.pendingRefine?.champion} toward ${s.pendingRefine?.directions.join(', ') || 'something new'}… this page updates by itself.`),
    champ ? h('div', { class: 'actions' }, h('button', { class: 'secondary', onclick: () => send({ type: 'ship', champion: champ.index }) }, `Stop and ship #${champ.index}`)) : null];
}

async function shippedView(s) {
  const r = await api(`/api/session/${id}/reveal`);
  const rev = r.ok ? await r.json() : null;
  const champ = candidate(s.shipped);
  const verdict = hit => h('span', { class: hit ? 'hit' : 'miss' }, hit ? 'called it' : 'missed');
  return [
    h('div', { class: 'bench' },
      h('div', {}, h('h2', {}, `Shipped #${champ.index}`), padFor(champ, { label: `${champ.index} ✓` })),
      h('div', { class: 'reveal' },
        h('div', { class: 'card' }, h('h2', {}, 'The agent'),
          rev?.agent ? [h('div', { class: 'big' }, `#${rev.agent.pick}`), verdict(rev.agent.hit), h('p', { class: 'hint' }, rev.agent.why || '')] : h('p', { class: 'hint' }, 'made no prediction')),
        h('div', { class: 'card' }, h('h2', {}, 'Your taste model'),
          rev?.model.pick == null ? h('p', { class: 'hint' }, 'had no judgements to learn from yet: this audition is its first lesson')
            : [h('div', { class: 'big' }, `#${rev.model.pick}`), verdict(rev.model.hit), h('p', { class: 'hint' }, `from ${rev.model.verdicts} earlier judgements`)]))),
  ];
}

async function render() {
  const s = data.state;
  $('#prompt').textContent = data.session.prompt || data.session.family;
  $('#meta').replaceChildren(h('div', {}, `${data.session.archetype && data.session.archetype !== data.session.family ? `${data.session.family} · ${data.session.archetype}` : data.session.family}`), h('div', {}, `${data.session.mode === 'live' ? 'agent is listening' : 'hand-off'} · round ${s.round}`));
  const order = ['lineup', 'duel', 'refine', 'shipped'];
  const current = s.stage === 'waiting' ? 'refine' : s.stage;
  document.querySelectorAll('#stages li').forEach(li => {
    const i = order.indexOf(li.dataset.stage), c = order.indexOf(current);
    li.toggleAttribute('aria-current', false);
    if (i === c) li.setAttribute('aria-current', 'step');
    li.classList.toggle('done', i < c);
  });
  $('#withKit').disabled = !data.kit.length;
  $('#withKit').title = data.kit.length ? `Play around: ${data.kit.map(k => k.name).join(', ')}` : 'No kit sounds yet';
  $('#withBed').disabled = !data.bed;

  let view;
  if (s.stage === 'lineup') view = lineupView(s);
  else if (s.stage === 'duel' && data.next.length) view = duelView();
  else if (s.stage === 'duel' || s.stage === 'refine') view = refineView(s);
  else if (s.stage === 'waiting') view = waitingView(s);
  else if (s.stage === 'shipped') view = await shippedView(s);
  else view = [h('p', { class: 'hint' }, 'This audition was closed.')];
  $('#stage').replaceChildren(...view);
  $('#keys').replaceChildren(...keysFor(s));

  clearTimeout(pollTimer);
  if (s.stage === 'waiting') pollTimer = setTimeout(load, 1500);
}

function keysFor(s) {
  const k = (key, what) => [h('kbd', {}, key), ` ${what}  `];
  if (s.stage === 'lineup') return [...k('1–9', 'play that number'), ...k('H', 'keep last played'), ...k('X', 'dud last played'), ...k('Esc', 'stop')];
  if (s.stage === 'duel') return [...k('Space', 'play left then right'), ...k('← →', 'pick'), ...k('↓', 'same'), ...k('↑', 'both bad')];
  return [...k('Esc', 'stop')];
}

// ---------- controls ----------
document.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.repeat) { repeat = Number(t.dataset.repeat); document.querySelectorAll('[data-repeat]').forEach(b => b.setAttribute('aria-pressed', b === t)); }
  if (t.dataset.speaker) { setSpeaker(t.dataset.speaker); document.querySelectorAll('[data-speaker]').forEach(b => b.setAttribute('aria-pressed', b === t)); }
});
$('#stop').addEventListener('click', stopAll);
$('#withKit').addEventListener('click', e => { withKit = !withKit; e.currentTarget.setAttribute('aria-pressed', withKit); });
$('#withBed').addEventListener('click', e => { setBed(!withBed); e.currentTarget.setAttribute('aria-pressed', withBed); });

document.addEventListener('keydown', async e => {
  if (!data || e.target.matches('input, textarea')) return;
  const s = data.state;
  if (e.key === 'Escape') { stopAll(); return; }
  if (s.stage === 'lineup') {
    // Keys follow the pad labels (candidate numbers), which continue across rounds.
    const n = Number(e.key);
    if (n >= 1 && n <= 9 && s.lineup.includes(n)) play(n);
    const onOffer = lastPlayed != null && s.lineup.includes(lastPlayed) && !(s.round > 0 && lastPlayed === s.champion);
    if ((e.key === 'h' || e.key === 'H') && onOffer) { marks.set(lastPlayed, 'love'); render(); }
    if ((e.key === 'x' || e.key === 'X') && onOffer) { marks.set(lastPlayed, 'dud'); render(); }
  } else if (s.stage === 'duel' && duelSides) {
    const buttons = document.querySelectorAll('.verdicts button');
    if (e.key === ' ') {
      e.preventDefault();
      const { left, right } = duelSides;
      const len = patch => (patch.duration ?? 0.3) + Math.max(...patch.layers.map(l => l.amp.release ?? 0.05)) + 0.25;
      await play(left, { count: 1 });
      setTimeout(() => { if (duelSides?.right === right) play(right, { count: 1 }); }, Math.min(3000, len(candidate(left).patch) * 1000));
    }
    if (e.key === 'ArrowLeft') buttons[0].click();
    if (e.key === 'ArrowDown') buttons[1].click();
    if (e.key === 'ArrowUp') buttons[2].click();
    if (e.key === 'ArrowRight') buttons[3].click();
  }
});

load().catch(e => fail(e.message));
