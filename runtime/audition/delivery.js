// Delivery-format audition page. Every lettered version of a sound is decoded with decodeAudioData (what a game would do) and
// played on one shared Web Audio clock, so switching letters carries on from the same moment with a few milliseconds of crossfade.
// The page never learns which preset a letter is until the owner reveals.

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
const SCALE = [['1', 'bad'], ['2', 'poor'], ['3', 'fair'], ['4', 'good'], ['5', 'best']];
const FAMILIES = { wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/ogg; codecs=opus' };
const FADE = 0.006;

const Ctx = window.AudioContext || window.webkitAudioContext;
const ctx = new Ctx();
let data = null, revealed = false, current = null;
const ratings = new Map(); // "item/letter" -> { rating, worse, note }
const players = [];

// ---- saving ----
const status = $('#status');
async function send(event) {
  try {
    const r = await api(`/api/delivery/${id}/event`, { method: 'POST', body: JSON.stringify(event), headers: { 'content-type': 'application/json' } });
    if (!r.ok) throw new Error((await r.json()).error?.message ?? r.statusText);
    status.textContent = 'Saved'; status.className = 'saved';
    return true;
  } catch (e) { status.textContent = `Not saved: ${e.message}. It will be sent again with your next change.`; status.className = 'bad'; return false; }
}
const dirty = new Set();
function flush() { for (const k of [...dirty]) { const [item, letter] = k.split('/'); const r = ratings.get(k); dirty.delete(k); send({ type: 'rate', item, letter, rating: r.rating ?? null, worse: !!r.worse, note: r.note ?? '' }).then(ok => { if (!ok) dirty.add(k); }); } }
let timer = 0;
const queue = (k, wait = 0) => { dirty.add(k); clearTimeout(timer); timer = setTimeout(flush, wait); };

// ---- decoding ----
const decodeAb = ab => new Promise((ok, fail) => { const p = ctx.decodeAudioData(ab, ok, fail); if (p && p.catch) p.catch(fail); });
async function decodeUrl(url) {
  const t0 = performance.now();
  try {
    const r = await api(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buffer = await decodeAb(await r.arrayBuffer());
    return { buffer, ms: Math.round(performance.now() - t0) };
  } catch (e) { return { error: String(e?.message ?? e?.name ?? e), ms: Math.round(performance.now() - t0) }; }
}

// ---- playback: one source at a time per sound, one sound at a time ----
class Player {
  constructor(item, card) {
    this.item = item; this.card = card; this.loop = item.loop; this.cache = new Map(); this.loaded = false;
    this.letter = item.tracks[0].letter; this.playing = false; this.offset = 0; this.startedAt = 0; this.src = null; this.gain = null;
    this.dur = item.durationSec;
  }
  at(time = ctx.currentTime) {
    if (!this.playing) return this.offset;
    const t = this.offset + (time - this.startedAt);
    return this.loop ? t % this.dur : Math.min(t, this.dur);
  }
  async load() {
    if (this.loaded) return;
    const label = $('.load', this.card);
    let n = 0;
    for (const t of this.item.tracks) {
      label.textContent = `Loading ${n}/${this.item.tracks.length}`;
      if (!this.cache.has(t.letter)) {
        const pk = `${this.item.id}/${t.letter}`, probed = probes.get(pk);
        probes.delete(pk); // the probe's buffer is only worth keeping until its sound is first played
        this.cache.set(t.letter, probed ?? await decodeUrl(t.url));
      }
      n++;
    }
    label.textContent = '';
    this.loaded = true;
    for (const t of this.item.tracks) if (this.cache.get(t.letter).error) $(`[data-letter="${t.letter}"]`, this.card).disabled = true;
  }
  release() { this.cache.clear(); this.loaded = false; }
  async start(letter, pos) {
    await ctx.resume();
    await this.load();
    const b = this.cache.get(letter);
    if (!b || b.error) { status.textContent = `${letter} cannot be decoded on this device: ${b?.error ?? 'unknown'}`; status.className = 'bad'; return; }
    const dur = b.buffer.duration;
    const t = ctx.currentTime + 0.02;
    // Position at the moment the new source starts, so an await above does not shift the switch point.
    const want = this.playing ? this.at(t) : pos;
    const off = this.loop ? want % dur : want >= dur ? 0 : want;
    const src = ctx.createBufferSource(); src.buffer = b.buffer; src.loop = this.loop;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(1, t + FADE);
    src.connect(gain).connect(ctx.destination);
    src.start(t, off);
    this.fadeOut(t);
    this.src = src; this.gain = gain; this.letter = letter; this.dur = dur; this.offset = off; this.startedAt = t; this.playing = true;
    src.onended = () => { if (this.src === src && !this.loop) { this.playing = false; this.offset = 0; this.src = null; refresh(); } };
    current = this;
    refresh();
  }
  fadeOut(t = ctx.currentTime) {
    if (!this.src) return;
    const g = this.gain, s = this.src;
    g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + FADE);
    s.onended = null; try { s.stop(t + FADE + 0.002); } catch { /* already stopped */ }
  }
  pause() {
    if (!this.playing) return;
    this.offset = this.at(); this.playing = false;
    this.fadeOut(); this.src = null;
    refresh();
  }
  seek(frac) {
    const pos = frac * this.dur;
    if (this.playing) { this.offset = pos; this.startedAt = ctx.currentTime; this.start(this.letter, pos); } else this.offset = pos;
    refresh();
  }
  async choose(letter) {
    this.letter = letter;
    if (this.playing) await this.start(letter, this.at());
    else await this.start(letter, this.offset);
    // A one-shot that ended replays from its start: tap letters in turn to compare the same sound.
  }
}

function playPause(p) {
  if (p.playing) { p.pause(); return; }
  if (current && current !== p) { current.pause(); current.release(); }
  p.start(p.letter, p.offset);
}

// ---- cards ----
function card(item) {
  const el = h('article', { class: 'card', 'data-item': item.id });
  const p = new Player(item, el);
  players.push(p);
  const strip = h('div', { class: 'strip', role: 'slider', tabindex: '0', 'aria-label': `Seek ${item.name}`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('div', { class: 'fill' }), h('div', { class: 'head' }));
  const seek = e => { const r = strip.getBoundingClientRect(); p.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); };
  strip.addEventListener('pointerdown', seek);
  strip.addEventListener('keydown', e => { if (e.key === 'ArrowRight') p.seek(Math.min(1, p.at() / p.dur + 0.05)); if (e.key === 'ArrowLeft') p.seek(Math.max(0, p.at() / p.dur - 0.05)); });
  const repeat = h('button', { class: 'toggle', 'aria-pressed': String(p.loop), onclick: e => { p.loop = !p.loop; e.currentTarget.setAttribute('aria-pressed', String(p.loop)); if (p.playing) p.start(p.letter, p.at()); } }, 'Repeat');
  const letters = h('div', { class: 'letters', role: 'group', 'aria-label': `Versions of ${item.name}` }, item.tracks.map(t => h('button', { class: 'letter', 'data-letter': t.letter, 'aria-pressed': 'false', onclick: () => { select(p, t.letter); p.choose(t.letter); } }, t.letter)));
  const rate = h('fieldset', { class: 'rate' });
  el.append(
    h('h3', {}, item.name, h('span', { class: 'role' }, `${item.role}${item.loop ? ' · loop' : ''} · ${mmss(item.durationSec)}`)),
    h('div', { class: 'xport' }, h('button', { class: 'deckkey', 'aria-label': `Play ${item.name}`, 'data-act': 'play', onclick: () => playPause(p) }, '▶'), strip, h('span', { class: 'time', 'data-act': 'time' }, `0:00 / ${mmss(item.durationSec)}`), repeat, h('span', { class: 'load' })),
    letters, rate);
  select(p, p.letter, rate);
  return { el, p, strip, rate };
}

/** The rating panel shows the letter being listened to. */
function select(p, letter, panel = $('.rate', p.card)) {
  p.letter = letter;
  const key = `${p.item.id}/${letter}`, r = ratings.get(key) ?? {};
  panel.replaceChildren(
    h('legend', {}, `Rate ${letter}`),
    h('div', { class: 'scale' }, SCALE.map(([n, w]) => h('button', { 'aria-pressed': String(r.rating === Number(n)), onclick: () => rateIt(p, letter, { rating: r.rating === Number(n) ? null : Number(n) }) }, n, h('small', {}, w)))),
    h('label', { class: 'worse' }, h('input', { type: 'checkbox', checked: !!r.worse, onchange: e => rateIt(p, letter, { worse: e.currentTarget.checked }) }), 'Sounds worse (artifacts, dull, smeared)'),
    h('div', {}, h('input', { type: 'text', 'aria-label': `Note on ${letter}`, maxlength: '1000', placeholder: 'Note (optional)', value: r.note ?? '', oninput: e => rateIt(p, letter, { note: e.currentTarget.value }, true) })));
  panel.disabled = revealed;
  refresh();
}
function rateIt(p, letter, patch, typing = false) {
  if (revealed) return;
  const key = `${p.item.id}/${letter}`;
  ratings.set(key, { ...(ratings.get(key) ?? {}), ...patch });
  queue(key, typing ? 700 : 0);
  if (!typing) select(p, letter);
  else refresh();
}

function refresh() {
  for (const p of players) {
    p.card.querySelectorAll('.letter').forEach(b => {
      const k = `${p.item.id}/${b.dataset.letter}`, r = ratings.get(k);
      b.setAttribute('aria-pressed', String(b.dataset.letter === p.letter));
      if (p.playing && b.dataset.letter === p.letter) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      b.querySelectorAll('.tag').forEach(t => t.remove());
      if (r?.rating) b.append(h('span', { class: 'tag' }, r.rating));
      if (r?.worse) b.append(h('span', { class: 'tag w' }, '↓'));
    });
    const play = $('[data-act=play]', p.card);
    play.textContent = p.playing ? '❚❚' : '▶';
    play.setAttribute('aria-label', `${p.playing ? 'Pause' : 'Play'} ${p.item.name}`);
  }
  $('#reveal').disabled = revealed || ![...ratings.values()].some(r => r.rating);
}

function tick() {
  for (const p of players) {
    const frac = p.dur ? p.at() / p.dur : 0;
    const strip = $('.strip', p.card);
    $('.head', strip).style.left = `${frac * 100}%`;
    $('.fill', strip).style.width = `${frac * 100}%`;
    strip.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    $('[data-act=time]', p.card).textContent = `${mmss(p.at())} / ${mmss(p.dur)}`;
  }
  requestAnimationFrame(tick);
}

// ---- what this device can decode ----
const probes = new Map(); // "item/letter" -> decode result, handed to the player that wants it
async function probeDevice() {
  const box = $('#device');
  const audio = document.createElement('audio');
  const report = { userAgent: navigator.userAgent, contextRate: ctx.sampleRate, canPlayType: {}, decode: {} };
  for (const [fam, mime] of Object.entries(FAMILIES)) report.canPlayType[fam] = audio.canPlayType ? (audio.canPlayType(mime) || 'no') : 'unknown';
  for (const fam of Object.keys(FAMILIES)) {
    const item = data.items.find(i => i.tracks.some(t => t.family === fam));
    const t = item?.tracks.find(x => x.family === fam);
    if (!t) { delete report.canPlayType[fam]; continue; }
    const res = await decodeUrl(t.url);
    probes.set(`${item.id}/${t.letter}`, res);
    const expected = Math.round(item.durationSec * ctx.sampleRate);
    report.decode[fam] = res.error ? { ok: false, error: res.error, ms: res.ms } : { ok: true, ms: res.ms, frames: res.buffer.length, expected, delta: res.buffer.length - expected };
  }
  const rows = Object.keys(report.decode).map(fam => {
    const d = report.decode[fam];
    return h('tr', {}, h('th', {}, { wav: 'WAV', mp3: 'MP3', opus: 'Ogg Opus' }[fam]), h('td', {}, `canPlayType: ${report.canPlayType[fam]}`),
      h('td', { class: d.ok ? 'good' : 'bad' }, d.ok ? `decodes in ${d.ms} ms` : `decode failed: ${d.error}`),
      h('td', {}, d.ok ? `length ${d.delta === 0 ? 'exact' : `${d.delta > 0 ? '+' : ''}${d.delta} frames`}` : ''));
  });
  box.replaceChildren(h('table', {}, rows), h('div', {}, `${navigator.userAgent} · audio context ${ctx.sampleRate} Hz`));
  send({ type: 'device', report });
}

// ---- reveal ----
const kb = n => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
async function showReveal() {
  const r = await api(`/api/delivery/${id}/reveal`);
  if (!r.ok) return;
  const rev = await r.json();
  revealed = true;
  players.forEach(p => p.pause());
  document.querySelectorAll('.rate').forEach(f => { f.disabled = true; });
  $('#reveal').disabled = true;
  const label = new Map(rev.key.map(k => [`${k.item}/${k.letter}`, k]));
  const rows = data.items.flatMap(it => it.tracks.map(t => {
    const k = label.get(`${it.id}/${t.letter}`), rt = ratings.get(`${it.id}/${t.letter}`) ?? {};
    return h('tr', {}, h('td', {}, it.name), h('td', {}, t.letter), h('td', {}, k.label), h('td', { class: 'num' }, kb(k.bytes)), h('td', { class: 'num' }, rt.rating ?? ''), h('td', {}, rt.worse ? 'worse' : ''));
  }));
  const hasProjection = rev.totals.some(t => t.projectedBytes !== undefined);
  const sections = [
    h('h2', {}, 'Which was which'),
    h('table', {}, h('tr', {}, ...['Sound', 'Letter', 'Version', 'Size', 'Your rating', ''].map((c, i) => h('th', { class: i === 3 || i === 4 ? 'num' : '' }, c))), rows),
    h('h2', {}, hasProjection ? 'Projected library size' : 'Size of these sounds'),
    h('table', {}, h('tr', {}, h('th', {}, 'Version'), h('th', { class: 'num' }, 'Bytes per second'), h('th', { class: 'num' }, hasProjection ? 'Library' : 'These sounds')),
      rev.totals.map(t => h('tr', {}, h('td', {}, t.label), h('td', { class: 'num' }, kb(t.bytesPerSec)), h('td', { class: 'num' }, kb(t.projectedBytes ?? t.bytes))))),
    h('h2', {}, 'What your ratings say'),
    ...Object.entries(rev.summary).map(([role, s]) => h('p', {},
      `${role}: original ${s.referenceMean ?? 'unrated'}, dull anchor ${s.anchorMean ?? 'unrated'}. `,
      s.screening.reliable === false ? h('span', { class: 'bad' }, 'The anchor did not sound worse than the original, so these ratings may be unreliable. ') : '',
      s.suggest ? h('span', { class: 'good' }, `Smallest version that held up: ${s.suggest}.`) : 'No compressed version held up within half a point of the original.')),
    h('p', {}, 'Your agent can now import these results.'),
  ];
  const box = $('#revealed');
  box.replaceChildren(...sections); box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth' });
}

// ---- boot ----
async function boot() {
  const r = await api(`/api/delivery/${id}`);
  if (!r.ok) { $('#title').textContent = 'Not found'; $('#howto').textContent = (await r.json()).error?.message ?? 'This listening session is gone.'; return; }
  data = await r.json();
  document.title = `${data.title} · agent-beeps`;
  $('#title').textContent = data.title;
  $('#meta').textContent = `${data.items.length} sound${data.items.length === 1 ? '' : 's'} · ${data.items[0].tracks.length} versions each`;
  for (const x of data.ratings) ratings.set(`${x.item}/${x.letter}`, { rating: x.rating, worse: x.worse, note: x.note });
  $('#overall').value = data.notes.at(-1) ?? '';
  const cards = data.items.map(card);
  $('#items').replaceChildren(...cards.map(c => c.el));
  for (const c of cards) select(c.p, c.p.letter, c.rate);
  let noteTimer = 0;
  $('#overall').addEventListener('input', e => { clearTimeout(noteTimer); noteTimer = setTimeout(() => send({ type: 'note', text: e.target.value }), 800); });
  $('#reveal').addEventListener('click', async () => {
    if (!confirm('Reveal which version each letter was? Ratings lock after this.')) return;
    flush();
    if (await send({ type: 'reveal' })) showReveal();
  });
  tick();
  refresh();
  if (data.revealed) showReveal();
  probeDevice();
}
boot();
