// runtime/player/player.js
// Game-side playback of exported agent-beeps audio: a voice-managed SFX bus, crossfading music and
// ambience beds, adaptive layers, and the renderer's safety clipper on the master. Importing it has
// no side effects; an AudioContext is created on the first unlock().
import { clipperCurve } from '../engine/fx.js';
import { createPicker } from '../engine/variation.js';
import { createVoiceManager } from './voices.js';
import { nextBarTime } from './timing.js';
import { createLifecycle } from './lifecycle.js';
import { createLoader, text } from './loader.js';
import { RAMP, fade, hold, ramp, span } from './params.js';

export { PLAYER_VERSION } from './version.js';
/** @type {readonly ['music', 'ambience']} */
const BEDS = ['music', 'ambience'];
/** Stable FNV-1a hash, so each sound gets its own variant pattern from one player seed. @param {string} s */
const hash = s => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

/**
 * @typedef {'music' | 'ambience'} BedBus
 * @typedef {'music' | 'ambience' | 'sfx' | 'master'} LevelBus
 * @typedef {{ file: string, weight?: number }} VariantFile
 * @typedef {{ name: string, file: string }} LayerFile
 * @typedef {{ file: string, loop?: boolean, priority?: number, cooldownSec?: number, cap?: number,
 *   variants?: VariantFile[], noRepeat?: boolean, bpm?: number, meter?: number, durationSec?: number,
 *   layers?: LayerFile[], states?: Record<string, string[]>, initialState?: string }} Asset
 * @typedef {{ code: string, message: string, id?: string }} PlayerError
 * @typedef {import('./loader.js').FetchResponse} FetchResponse
 * @typedef {{ src: AudioBufferSourceNode, gain: GainNode, target: number }} Playing one source and its gain
 * @typedef {{ id: string, asset: Asset, group: GainNode, layers: Map<string, Playing>, startTime: number, state: string | null }} Bed
 * @typedef {{ id: string | null, fadeSec: number, token: number }} Pending
 */

/**
 * @param {{
 *   catalog: string | { assets: Record<string, Asset> },
 *   baseUrl?: string,
 *   voices?: number,
 *   defaults?: { cooldownSec?: number, cap?: number },
 *   onError?: (e: PlayerError) => void,
 *   context?: AudioContext,
 *   contextFactory?: () => AudioContext,
 *   fetcher?: (url: string) => Promise<FetchResponse>,
 *   seed?: number,
 * }} opts
 */
export function createPlayer(opts) {
  const { catalog, voices = 8, defaults = {}, onError = () => {}, seed = 1 } = opts;
  const contextFactory = opts.contextFactory ?? (() => opts.context ?? new AudioContext());
  const vm = createVoiceManager({ budget: voices });
  /** @type {Record<LevelBus, number>} */
  const levels = { music: 1, ambience: 1, sfx: 1, master: 1 };
  const warned = new Set();
  /** @type {Map<string, { next(): number }>} */
  const pickers = new Map();
  /** @type {Map<number, Playing>} */
  const live = new Map();
  /** @type {Record<BedBus, Bed | null>} */
  const beds = { music: null, ambience: null };
  /** @type {Record<BedBus, Pending | undefined>} */
  const pending = { music: undefined, ambience: undefined };
  const tokens = { music: 0, ambience: 0 };
  /** The music id being loaded right now, so setState can aim at it rather than the old bed. @type {string | null} */
  let loadingMusic = null;
  /** @type {string | null} */
  let pendingState = null;
  let enabled = true, hidden = false;
  /** @type {AudioContext | null} */
  let ctx = null;
  /** @type {ReturnType<typeof createLifecycle> | null} */
  let lifecycle = null;
  /** @type {GainNode | null} */
  let master = null;
  /** @type {Record<'music' | 'ambience' | 'sfx', GainNode> | null} */
  let buses = null;

  /** @param {string} code @param {string} message @param {string} [id] */
  const report = (code, message, id) => {
    try { onError({ code, message, ...(id !== undefined ? { id } : {}) }); } catch { /* a game's handler must not break audio */ }
  };
  /** @param {string} code @param {string} message @param {string} id */
  const warnOnce = (code, message, id) => {
    const k = `${code}:${id}`;
    if (!warned.has(k)) { warned.add(k); report(code, message, id); }
  };
  /** Only called once a context exists. */
  const now = () => /** @type {AudioContext} */ (ctx).currentTime;
  const loader = createLoader({
    catalog,
    base: opts.baseUrl ?? (typeof catalog === 'string' ? catalog.slice(0, catalog.lastIndexOf('/') + 1) : ''),
    fetcher: opts.fetcher ?? (url => fetch(url)),
    report,
    now: () => ctx?.currentTime ?? 0,
    decode: data => /** @type {AudioContext} */ (ctx).decodeAudioData(data),
  });
  // Wanted AND actually running. `enabled` is checked directly because disabling suspends only
  // after the stop fade; the context state because after setEnabled(true) without a gesture it is
  // still suspended, and sounds started then would hold voices and all burst out on resume.
  const running = () => enabled && !hidden && !!ctx && !!lifecycle && lifecycle.running && ctx.state === 'running';

  function build() {
    const c = contextFactory();
    try { graph(c); } catch (e) {
      // The context exists but its graph does not: close it so a retry does not leak contexts, unless
      // the game passed it in, in which case it is the game's to close.
      if (c !== opts.context) Promise.resolve().then(() => c.close?.()).catch(() => {});
      throw e;
    }
  }

  /** @param {AudioContext} c */
  function graph(c) {
    ctx = c;
    const shaper = c.createWaveShaper();
    shaper.curve = clipperCurve();
    shaper.oversample = 'none';
    const m = c.createGain();
    m.gain.value = levels.master;
    m.connect(shaper);
    shaper.connect(c.destination);
    master = m;
    /** @param {'music' | 'ambience' | 'sfx'} b */
    const bus = b => { const g = c.createGain(); g.gain.value = levels[b]; g.connect(m); return g; };
    buses = { music: bus('music'), ambience: bus('ambience'), sfx: bus('sfx') };
    lifecycle = createLifecycle(c, { enabled, hidden });
  }

  /** @param {AudioBuffer} buffer @param {AudioNode} out @param {{ loop?: boolean, gainDb?: number, pan?: number, level?: number }} o @returns {Playing} */
  function source(buffer, out, { loop = false, gainDb = 0, pan = 0, level } = {}) {
    const c = /** @type {AudioContext} */ (ctx);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    const gain = c.createGain();
    const target = level ?? 10 ** (gainDb / 20);
    gain.gain.value = target;
    src.connect(gain);
    if (pan) { const p = c.createStereoPanner(); p.pan.value = pan; gain.connect(p); p.connect(out); } else gain.connect(out);
    return { src, gain, target };
  }

  /** @param {Playing} n @param {number} [fadeSec] */
  function stopPlaying(n, fadeSec = RAMP) {
    const t = now();
    ramp(n.gain.gain, 0, fadeSec, t);
    try { n.src.stop(t + span(fadeSec)); } catch { /* already stopped */ }
  }

  /** Best-effort teardown of nodes from a start that failed partway: never throws. @param {Iterable<Playing>} nodes */
  function discard(nodes) {
    for (const n of nodes) {
      try { n.src.stop(); } catch { /* never started */ }
      try { n.src.disconnect(); n.gain.disconnect(); } catch { /* already disconnected */ }
    }
  }

  /** @param {Bed} bed @param {number} [fadeSec] @param {number} [at] when the fade starts (default now) */
  function stopBed(bed, fadeSec = RAMP, at = now()) {
    const g = bed.group.gain;
    hold(g, at, now());
    g.linearRampToValueAtTime(0, at + span(fadeSec));
    for (const n of bed.layers.values()) { try { n.src.stop(at + span(fadeSec)); } catch { /* already stopped */ } }
  }

  /** @param {string} id @param {Asset} asset */
  function pickerFor(id, asset) {
    let picker = pickers.get(id);
    if (!picker) {
      const files = asset.variants?.length ? asset.variants : [{ file: asset.file, weight: 1 }];
      const variation = { variants: files.length, weights: files.map(f => f.weight ?? 1), noRepeat: asset.noRepeat ?? true };
      picker = createPicker({ variation }, (seed ^ hash(id)) >>> 0);
      pickers.set(id, picker);
    }
    return picker;
  }

  /**
   * Play a sound effect. Null when dropped (before unlock, hidden, unknown, voice budget, cooldown).
   * @param {string} id
   * @param {{ pan?: number, gainDb?: number, cooldownSec?: number, cap?: number }} [o]
   */
  function play(id, { pan = 0, gainDb = 0, cooldownSec, cap } = {}) {
    if (!ctx || !running() || !buses) return null;
    const assets = loader.assets;
    if (!assets) { loader.retryCatalog(); return null; } // throttled: safe from a per-frame play()
    const asset = assets[id];
    if (!asset) { warnOnce('E_UNKNOWN_ASSET', `no asset "${id}"`, id); return null; }
    if (asset.loop) { warnOnce('E_NOT_SFX', `"${id}" loops: play it with music() or ambience()`, id); return null; }
    const grant = vm.request(id, {
      priority: asset.priority ?? 3,
      cooldownSec: cooldownSec ?? asset.cooldownSec ?? defaults.cooldownSec ?? 0.05,
      cap: cap ?? asset.cap ?? defaults.cap ?? 3,
    }, ctx.currentTime);
    if (!grant) return null;
    if (grant.steal !== null) { const v = live.get(grant.steal); live.delete(grant.steal); if (v) stopPlaying(v); }
    const files = asset.variants?.length ? asset.variants : [{ file: asset.file }];
    const file = files[pickerFor(id, asset).next()].file;
    const sfx = buses.sfx;
    const handle = {
      id, file, stopped: false,
      /** @type {Promise<boolean>} */
      ready: Promise.resolve(false),
      /** @param {number} [fadeSec] */
      stop(fadeSec = RAMP) {
        handle.stopped = true;
        const v = live.get(grant.key);
        live.delete(grant.key);
        vm.release(grant.key);
        if (v) stopPlaying(v, fade(fadeSec));
      },
    };
    handle.ready = loader.load(file).then(buffer => {
      if (!buffer || handle.stopped || !running() || !vm.has(grant.key)) { vm.release(grant.key); return false; }
      /** @type {Playing | null} */
      let v = null;
      try {
        const node = source(buffer, sfx, { gainDb, pan });
        v = node;
        live.set(grant.key, node);
        node.src.onended = () => {
          if (live.get(grant.key) === node) { live.delete(grant.key); vm.release(grant.key); }
          try { node.src.disconnect(); node.gain.disconnect(); } catch { /* already disconnected */ }
        };
        node.src.start(now());
        return true;
      } catch (e) {
        // A Web Audio call threw: report it, free the voice, and resolve rather than reject.
        if (live.get(grant.key) === v) live.delete(grant.key);
        vm.release(grant.key);
        if (v) discard([v]);
        report('E_PLAYBACK', text(e), id);
        return false;
      }
    });
    return handle;
  }

  /**
   * Crossfade a bed to `id` (null fades it out). Resolves true once it plays, false when superseded,
   * queued (before unlock or while hidden), or unavailable. Never rejects.
   * @param {BedBus} bus
   * @param {string | null} id
   * @param {{ fadeSec?: number }} [o]
   * @returns {Promise<boolean>}
   */
  function bed(bus, id, { fadeSec: requested = 2 } = {}) {
    const fadeSec = fade(requested);
    const token = ++tokens[bus];
    if (!running()) {
      pending[bus] = { id, fadeSec, token };
      if (bus === 'music') loadingMusic = null; // any load in flight is now superseded
      return Promise.resolve(false);
    }
    pending[bus] = undefined; // a direct request supersedes anything queued
    const cur = beds[bus];
    if (bus === 'music') loadingMusic = cur && cur.id === id ? null : id;
    if (cur && cur.id === id) return Promise.resolve(true);
    if (id === null) { if (cur) stopBed(cur, fadeSec); beds[bus] = null; return Promise.resolve(true); }
    /** @param {boolean} ok */
    const done = ok => { if (bus === 'music' && token === tokens.music) loadingMusic = null; return ok; };
    // The latest music request could not play: a state kept for it must not leak onto later music.
    const fail = () => { if (bus === 'music' && token === tokens.music) pendingState = null; return false; };
    return loader.catalog().then(assets => {
      if (token !== tokens[bus]) return false;
      if (!assets) return fail();
      const asset = assets[id];
      if (!asset) { warnOnce('E_UNKNOWN_ASSET', `no asset "${id}"`, id); return fail(); }
      return Promise.all(partsOf(asset).map(p => loader.load(p.file))).then(bufs => {
        if (token !== tokens[bus]) return false;
        if (bufs.every(b => !b)) return fail();
        // Loaded while hidden (or suspended): queue it again so showing the tab starts it.
        if (!running()) { pending[bus] = { id, fadeSec, token }; return false; }
        return startBed(bus, id, asset, bufs, fadeSec) || fail();
      });
    }).catch(e => { report('E_PLAYBACK', text(e), id); return fail(); }).then(done);
  }

  /** @param {Asset} asset @returns {LayerFile[]} */
  const partsOf = asset => (asset.layers?.length ? asset.layers : [{ name: '', file: asset.file }]);

  /**
   * Start a loaded bed's layers together, swap it in and fade the previous bed out. A Web Audio
   * failure partway is reported and torn down, leaving the previous bed playing.
   * @param {BedBus} bus @param {string} id @param {Asset} asset @param {(AudioBuffer | null)[]} bufs @param {number} fadeSec
   * @returns {boolean}
   */
  function startBed(bus, id, asset, bufs, fadeSec) {
    const c = /** @type {AudioContext} */ (ctx);
    /** @type {Map<string, Playing>} */
    const layers = new Map();
    /** @type {GainNode | null} */
    let group = null;
    try {
      const t = c.currentTime + 0.05; // one shared start: layers stay sample-aligned
      const g = c.createGain();
      group = g;
      g.gain.value = 0;
      g.connect(/** @type {NonNullable<typeof buses>} */ (buses)[bus]);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + span(fadeSec));
      const wanted = bus === 'music' && pendingState && asset.states?.[pendingState] ? pendingState : null;
      const state = asset.layers?.length ? wanted ?? asset.initialState ?? null : null;
      const on = state ? new Set(asset.states?.[state] ?? []) : null;
      partsOf(asset).forEach((p, i) => {
        const b = bufs[i];
        if (!b) return; // a missing layer file: only that layer is silent
        const n = source(b, g, { loop: asset.loop !== false, level: !on || on.has(p.name) ? 1 : 0 });
        layers.set(p.name, n); // before start(): a throwing start must still be torn down
        n.src.start(t);
      });
      const previous = beds[bus];
      /** @type {Bed} */
      const started = { id, asset, group: g, layers, startTime: t, state };
      beds[bus] = started;
      // Once every layer has ended (faded out by a crossfade or stop, or a non-looping bed that ran
      // out), free the whole bed's graph, and forget the bed if it is still the current one.
      let ended = 0;
      for (const n of layers.values()) {
        n.src.onended = () => {
          if (++ended < layers.size) return;
          if (beds[bus] === started) beds[bus] = null;
          discard(layers.values());
          try { g.disconnect(); } catch { /* already disconnected */ }
        };
      }
      if (bus === 'music') pendingState = null;
      if (previous) stopBed(previous, fadeSec, t); // fade out exactly as the new bed fades in
      return true;
    } catch (e) {
      discard(layers.values());
      if (beds[bus]?.layers === layers) beds[bus] = null; // it failed after the swap
      try { group?.disconnect(); } catch { /* already disconnected */ }
      report('E_PLAYBACK', text(e), id);
      return false;
    }
  }

  /**
   * Fade the current music's layers to a state, now or at the next bar line. If other music is
   * loading or queued, the state is kept for it instead.
   * @param {string} state
   * @param {{ fadeSec?: number, at?: 'now' | 'bar' }} [o]
   */
  function setState(state, { fadeSec: requested = 1.5, at = 'now' } = {}) {
    const fadeSec = fade(requested);
    const cur = beds.music;
    const queued = pending.music && pending.music.token === tokens.music ? pending.music.id : null;
    const next = loadingMusic ?? queued;
    if (!cur || !ctx || (next !== null && next !== cur.id)) { pendingState = state; return false; }
    const { asset } = cur;
    if (!asset.layers?.length) { warnOnce('E_NOT_ADAPTIVE', `"${cur.id}" has no adaptive layers`, cur.id); return false; }
    const on = asset.states?.[state];
    if (!on) { warnOnce('E_UNKNOWN_STATE', `"${cur.id}" has no state "${state}"`, state); return false; }
    const t = ctx.currentTime;
    const when = at === 'bar' && asset.bpm ? nextBarTime(cur.startTime, t, asset.bpm, asset.meter ?? 4, asset.durationSec) : t;
    for (const [name, n] of cur.layers) {
      const target = on.includes(name) ? 1 : 0;
      hold(n.gain.gain, when, t, n.target); // the actual level at `when`, not the previous goal
      n.gain.gain.linearRampToValueAtTime(target, when + span(fadeSec));
      n.target = target;
    }
    cur.state = state;
    return true;
  }

  /** @param {LevelBus} bus @param {number} value */
  function setLevel(bus, value) {
    if (!Object.hasOwn(levels, bus) || !Number.isFinite(value)) return; // untyped callers too
    levels[bus] = Math.min(1, Math.max(0, value));
    if (ctx && master && buses) ramp(bus === 'master' ? master.gain : buses[bus].gain, levels[bus], RAMP, now());
  }

  /** @param {number} [fadeSec] */
  function stopAll(fadeSec = RAMP) {
    fadeSec = fade(fadeSec);
    for (const b of BEDS) {
      tokens[b]++;
      pending[b] = undefined;
      const cur = beds[b];
      if (cur && ctx) stopBed(cur, fadeSec);
      beds[b] = null;
    }
    pendingState = null;
    loadingMusic = null;
    if (ctx) for (const n of live.values()) stopPlaying(n, fadeSec);
    live.clear();
    vm.clear();
  }

  /** Call from a user gesture: creates or resumes the context, then starts queued beds. */
  async function unlock() {
    if (!enabled || hidden) return false;
    if (!ctx) {
      // No Web Audio (or a factory that throws) is reported, never thrown: the next unlock retries.
      try { build(); } catch (e) { ctx = null; master = null; buses = null; lifecycle = null; report('E_CONTEXT', text(e)); return false; }
    }
    const life = /** @type {ReturnType<typeof createLifecycle>} */ (lifecycle);
    try { await life.reconcile(); } catch (e) { report('E_CONTEXT', text(e)); return false; }
    await loader.catalog();
    if (!running()) return false;
    await drainPending();
    return running();
  }

  /** Start the beds requested while the context could not run (before unlock, or while hidden). */
  async function drainPending() {
    for (const b of BEDS) {
      const p = pending[b];
      pending[b] = undefined;
      if (p && p.token === tokens[b]) await bed(b, p.id, { fadeSec: p.fadeSec }); // else a newer request won
    }
  }

  /** @param {boolean} value */
  function setEnabled(value) {
    enabled = !!value;
    if (!enabled) {
      stopAll();
      // Suspend once the stop fade has finished, so the context does not freeze mid-ramp. play()
      // and beds are refused meanwhile, because running() checks `enabled`. Re-enabling inside the
      // delay cancels the suspend: the context never stopped, so no gesture is needed.
      const life = lifecycle;
      if (life) setTimeout(() => { if (!enabled) void life.setEnabled(false).catch(e => report('E_CONTEXT', text(e))); }, RAMP * 1000 + 10);
    } else if (lifecycle) lifecycle.allow(); // resuming a suspended context needs a gesture: the next unlock() does it
  }

  /** @param {boolean} value */
  function setHidden(value) {
    hidden = !!value;
    if (!lifecycle) return;
    // Showing the tab again resumes without a new gesture: the page already has sticky user
    // activation from the unlock() that created the context, so browsers allow resume() here.
    void lifecycle.setHidden(hidden)
      .then(() => (running() ? drainPending() : undefined))
      .catch(e => report('E_CONTEXT', text(e)));
  }

  /**
   * Forget failed loads so the next play() / music() / ambience() / unlock() fetches and reports
   * again: for a "toggle sound to try again" after a network blip. Keeps loaded sounds, whatever is
   * playing, and the AudioContext.
   */
  function retry() {
    loader.reset();
    for (const k of warned) if (k.startsWith('E_LOAD:') || k.startsWith('E_CATALOG:')) warned.delete(k);
  }

  /** A snapshot for tests, debugging and game UI. */
  function inspect() {
    const m = beds.music, a = beds.ambience;
    return {
      running: running(), voices: vm.size, levels: { ...levels },
      music: m ? { id: m.id, state: m.state, layers: Object.fromEntries([...m.layers].filter(([name]) => name).map(([name, n]) => [name, n.target])) } : null,
      ambience: a ? { id: a.id } : null,
    };
  }

  return {
    unlock, play, setState, setLevel, setEnabled, setHidden, stopAll, retry, inspect,
    /** @param {string | null} id @param {{ fadeSec?: number }} [o] */
    music: (id, o) => bed('music', id, o),
    /** @param {string | null} id @param {{ fadeSec?: number }} [o] */
    ambience: (id, o) => bed('ambience', id, o),
  };
}
