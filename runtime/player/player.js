// runtime/player/player.js
// Game-side playback of exported agent-beeps audio: a voice-managed SFX bus, crossfading music and
// ambience beds, adaptive layers, and the renderer's safety clipper on the master. Importing it has
// no side effects; an AudioContext is created on the first unlock().
import { clipperCurve } from '../engine/fx.js';
import { createPicker } from '../engine/variation.js';
import { createVoiceManager } from './voices.js';
import { nextBarTime } from './timing.js';
import { createLifecycle } from './lifecycle.js';

export const PLAYER_VERSION = '1';
const RAMP = 0.02; // seconds: no level change is instant, so nothing clicks
const CATALOG_RETRY_SEC = 5; // play() retries a failed catalog at most this often (context time)
/** @type {readonly ['music', 'ambience']} */
const BEDS = ['music', 'ambience'];
/** A usable fade length: a non-finite or non-positive one would schedule NaN times, which throw. @param {unknown} x */
const fade = x => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : RAMP);
/** Stable FNV-1a hash, so each sound gets its own variant pattern from one player seed. @param {string} s */
const hash = s => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

/**
 * @typedef {{ file: string, weight?: number }} VariantFile
 * @typedef {{ name: string, file: string }} LayerFile
 * @typedef {{ file: string, loop?: boolean, priority?: number, cooldownSec?: number, cap?: number,
 *   variants?: VariantFile[], noRepeat?: boolean, bpm?: number, meter?: number, durationSec?: number,
 *   layers?: LayerFile[], states?: Record<string, string[]>, initialState?: string }} Asset
 * @typedef {{ code: string, message: string, id?: string }} PlayerError
 * @typedef {{ ok: boolean, json(): Promise<any>, arrayBuffer(): Promise<ArrayBuffer> }} FetchResponse
 * @typedef {{ src: AudioBufferSourceNode, gain: GainNode, target: number }} Node
 * @typedef {{ id: string, asset: Asset, group: GainNode, layers: Map<string, Node>, startTime: number, state: string | null }} Bed
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
  const fetcher = opts.fetcher ?? (url => fetch(url));
  const base = opts.baseUrl ?? (typeof catalog === 'string' ? catalog.slice(0, catalog.lastIndexOf('/') + 1) : '');
  const vm = createVoiceManager({ budget: voices });
  /** @type {Record<'music' | 'ambience' | 'sfx' | 'master', number>} */
  const levels = { music: 1, ambience: 1, sfx: 1, master: 1 };
  const warned = new Set();
  /** @type {Map<string, Promise<AudioBuffer | null>>} */
  const buffers = new Map();
  /** @type {Map<string, number>} */
  const failures = new Map();
  /** @type {Map<string, { next(): number }>} */
  const pickers = new Map();
  /** @type {Map<number, Node>} */
  const live = new Map();
  /** @type {Record<'music' | 'ambience', Bed | null>} */
  const beds = { music: null, ambience: null };
  /** @type {Record<'music' | 'ambience', { id: string | null, fadeSec: number } | undefined>} */
  const pending = { music: undefined, ambience: undefined };
  const tokens = { music: 0, ambience: 0 };
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
  /** @type {Record<string, Asset> | null} */
  let assets = null;
  /** @type {Promise<Record<string, Asset> | null> | null} */
  let catalogLoad = null;
  let catalogRetryAt = 0; // context time before which play() will not retry a failed catalog

  /** @param {string} code @param {string} message @param {string} [id] */
  const report = (code, message, id) => {
    try { onError({ code, message, ...(id !== undefined ? { id } : {}) }); } catch { /* a game's handler must not break audio */ }
  };
  /** @param {string} code @param {string} message @param {string} id */
  const warnOnce = (code, message, id) => {
    const k = `${code}:${id}`;
    if (!warned.has(k)) { warned.add(k); report(code, message, id); }
  };
  /**
   * Freeze `param` at whatever it is doing at `at`, even mid-ramp, so the next ramp starts there and
   * nothing snaps. Browsers have cancelAndHoldAtTime. The fallback holds the current value for an
   * immediate change; for a future `at` (a bar line) it holds `scheduled`, the last target, since
   * the level now may be mid-fade toward it and would snap back at the bar.
   * @param {AudioParam} param @param {number} at @param {number} [scheduled]
   */
  const hold = (param, at, scheduled) => {
    if (typeof param.cancelAndHoldAtTime === 'function') { param.cancelAndHoldAtTime(at); return; }
    const future = at > /** @type {AudioContext} */ (ctx).currentTime + 1e-9;
    param.cancelScheduledValues(at);
    param.setValueAtTime(future && scheduled !== undefined ? scheduled : param.value, at);
  };
  /** @param {unknown} e */
  const text = e => String((/** @type {any} */ (e))?.message ?? e);
  /** @param {AudioParam} param @param {number} to @param {number} [sec] @param {number} [at] */
  const ramp = (param, to, sec = RAMP, at = /** @type {AudioContext} */ (ctx).currentTime) => {
    hold(param, at);
    param.linearRampToValueAtTime(to, at + Math.max(RAMP, fade(sec)));
  };
  // Wanted (lifecycle) AND actually running: after setEnabled(true) without a gesture the context
  // is still suspended, and sounds started then would hold voices and all burst out on resume.
  const running = () => !!ctx && !!lifecycle && lifecycle.running && ctx.state === 'running';

  function loadCatalog() {
    if (assets) return Promise.resolve(assets);
    if (typeof catalog !== 'string') { assets = catalog.assets ?? {}; return Promise.resolve(assets); }
    catalogLoad ??= fetcher(catalog)
      .then(r => { if (!r.ok) throw new Error(`catalog ${catalog} unavailable`); return r.json(); })
      .then(j => { assets = j.assets ?? {}; return assets; })
      .catch(e => { catalogLoad = null; warnOnce('E_CATALOG', text(e), String(catalog)); return null; });
    return catalogLoad;
  }

  /** @param {string} file @returns {Promise<AudioBuffer | null>} */
  function load(file) {
    const url = base + file;
    const cached = buffers.get(url);
    if (cached) return cached;
    if ((failures.get(url) ?? 0) >= 2) return Promise.resolve(null); // one retry, then silence
    const p = Promise.resolve()
      .then(() => fetcher(url))
      .then(r => { if (!r.ok) throw new Error(`${url} unavailable`); return r.arrayBuffer(); })
      .then(b => /** @type {AudioContext} */ (ctx).decodeAudioData(b))
      .catch(e => { buffers.delete(url); failures.set(url, (failures.get(url) ?? 0) + 1); report('E_LOAD', text(e), file); return null; });
    buffers.set(url, p);
    return p;
  }

  function build() {
    const c = contextFactory();
    ctx = c;
    const shaper = c.createWaveShaper();
    shaper.curve = clipperCurve();
    shaper.oversample = 'none';
    master = c.createGain();
    master.gain.value = levels.master;
    master.connect(shaper);
    shaper.connect(c.destination);
    const m = master;
    /** @param {'music' | 'ambience' | 'sfx'} b */
    const bus = b => { const g = c.createGain(); g.gain.value = levels[b]; g.connect(m); return g; };
    buses = { music: bus('music'), ambience: bus('ambience'), sfx: bus('sfx') };
    lifecycle = createLifecycle(c, { enabled, hidden });
  }

  /** @param {AudioBuffer} buffer @param {AudioNode} out @param {{ loop?: boolean, gainDb?: number, pan?: number, level?: number }} o @returns {Node} */
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

  /** @param {Node} n @param {number} [fadeSec] */
  function stopNode(n, fadeSec = RAMP) {
    const t = /** @type {AudioContext} */ (ctx).currentTime;
    ramp(n.gain.gain, 0, fadeSec, t);
    try { n.src.stop(t + Math.max(RAMP, fade(fadeSec))); } catch { /* already stopped */ }
  }

  /** Best-effort teardown of nodes from a start that failed partway: never throws. @param {Node[]} nodes */
  function discard(nodes) {
    for (const n of nodes) {
      try { n.src.stop(); } catch { /* never started */ }
      try { n.src.disconnect(); n.gain.disconnect(); } catch { /* already disconnected */ }
    }
  }

  /** @param {Bed} bed @param {number} [fadeSec] */
  function stopBed(bed, fadeSec = RAMP) {
    const t = /** @type {AudioContext} */ (ctx).currentTime;
    ramp(bed.group.gain, 0, fadeSec, t);
    for (const n of bed.layers.values()) { try { n.src.stop(t + Math.max(RAMP, fade(fadeSec))); } catch { /* already stopped */ } }
  }

  /**
   * Play a sound effect. Null when dropped (before unlock, hidden, unknown, voice budget, cooldown).
   * @param {string} id
   * @param {{ pan?: number, gainDb?: number, cooldownSec?: number, cap?: number }} [o]
   */
  function play(id, { pan = 0, gainDb = 0, cooldownSec, cap } = {}) {
    if (!ctx || !running() || !buses) return null;
    if (!assets) {
      // A failed catalog retries, as beds do, but at most once per CATALOG_RETRY_SEC: a game calling
      // play() every frame must not refetch every frame.
      if (!catalogLoad && ctx.currentTime >= catalogRetryAt) { catalogRetryAt = ctx.currentTime + CATALOG_RETRY_SEC; void loadCatalog(); }
      return null;
    }
    const asset = assets[id];
    if (!asset) { warnOnce('E_UNKNOWN_ASSET', `no asset "${id}"`, id); return null; }
    if (asset.loop) { warnOnce('E_NOT_SFX', `"${id}" loops: play it with music() or ambience()`, id); return null; }
    const grant = vm.request(id, {
      priority: asset.priority ?? 3,
      cooldownSec: cooldownSec ?? asset.cooldownSec ?? defaults.cooldownSec ?? 0.05,
      cap: cap ?? asset.cap ?? defaults.cap ?? 3,
    }, ctx.currentTime);
    if (!grant) return null;
    if (grant.steal !== null) { const v = live.get(grant.steal); live.delete(grant.steal); if (v) stopNode(v); }
    const files = asset.variants?.length ? asset.variants : [{ file: asset.file }];
    let picker = pickers.get(id);
    if (!picker) {
      picker = createPicker(/** @type {any} */ ({ variation: { variants: files.length, weights: files.map(f => f.weight ?? 1), noRepeat: asset.noRepeat ?? true } }), (seed ^ hash(id)) >>> 0);
      pickers.set(id, picker);
    }
    const file = files[picker.next()].file;
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
        if (v) stopNode(v, fade(fadeSec));
      },
    };
    handle.ready = load(file).then(buffer => {
      if (!buffer || handle.stopped || !running() || !vm.has(grant.key)) { vm.release(grant.key); return false; }
      /** @type {Node | null} */
      let v = null;
      try {
        const node = source(buffer, sfx, { gainDb, pan });
        v = node;
        live.set(grant.key, node);
        node.src.onended = () => {
          if (live.get(grant.key) === node) { live.delete(grant.key); vm.release(grant.key); }
          try { node.src.disconnect(); node.gain.disconnect(); } catch { /* already disconnected */ }
        };
        node.src.start(/** @type {AudioContext} */ (ctx).currentTime);
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
   * queued before unlock, or unavailable.
   * @param {'music' | 'ambience'} bus
   * @param {string | null} id
   * @param {{ fadeSec?: number }} [o]
   * @returns {Promise<boolean>}
   */
  function bed(bus, id, { fadeSec: requested = 2 } = {}) {
    const fadeSec = fade(requested);
    const token = ++tokens[bus];
    if (!ctx || !running() || !buses) { pending[bus] = { id, fadeSec }; return Promise.resolve(false); }
    const cur = beds[bus];
    if (cur && cur.id === id) return Promise.resolve(true);
    if (id === null) { if (cur) stopBed(cur, fadeSec); beds[bus] = null; return Promise.resolve(true); }
    const out = buses[bus];
    return loadCatalog().then(a => {
      if (!a || token !== tokens[bus]) return false;
      const asset = a[id];
      if (!asset) { warnOnce('E_UNKNOWN_ASSET', `no asset "${id}"`, id); return false; }
      const parts = asset.layers?.length ? asset.layers : [{ name: '', file: asset.file }];
      return Promise.all(parts.map(p => load(p.file))).then(bufs => {
        if (token !== tokens[bus] || !running() || bufs.every(b => !b)) return false;
        /** @type {Map<string, Node>} */
        const layers = new Map();
        /** @type {GainNode | null} */
        let group = null;
        try {
          return startBed(bus, id, asset, parts, bufs, out, fadeSec, layers, g => { group = g; });
        } catch (e) {
          // A Web Audio call threw partway: stop what started, leave the previous bed, resolve false.
          discard([...layers.values()]);
          if (beds[bus]?.layers === layers) beds[bus] = null; // it failed after the swap
          try { /** @type {GainNode | null} */ (group)?.disconnect(); } catch { /* already disconnected */ }
          report('E_PLAYBACK', text(e), id);
          return false;
        }
      });
    }).catch(e => { report('E_PLAYBACK', text(e), id); return false; });
  }

  /**
   * Start a loaded bed's layers together and swap it in. May throw on a Web Audio failure; the
   * caller cleans up `layers` and the group it was handed.
   * @param {'music' | 'ambience'} bus @param {string} id @param {Asset} asset
   * @param {{ name: string, file: string }[]} parts @param {(AudioBuffer | null)[]} bufs
   * @param {AudioNode} out @param {number} fadeSec @param {Map<string, Node>} layers
   * @param {(g: GainNode) => void} onGroup
   */
  function startBed(bus, id, asset, parts, bufs, out, fadeSec, layers, onGroup) {
    const c = /** @type {AudioContext} */ (ctx);
    const t = c.currentTime + 0.05; // one shared start: layers stay sample-aligned
    const group = c.createGain();
    onGroup(group);
    group.gain.value = 0;
    group.connect(out);
    group.gain.setValueAtTime(0, t);
    group.gain.linearRampToValueAtTime(1, t + Math.max(RAMP, fade(fadeSec)));
    const adaptive = !!asset.layers?.length;
    const wanted = pendingState && asset.states?.[pendingState] ? pendingState : null;
    const state = adaptive ? (bus === 'music' && wanted ? wanted : asset.initialState ?? null) : null;
    const on = state ? new Set(asset.states?.[state] ?? []) : null;
    parts.forEach((p, i) => {
      const b = bufs[i];
      if (!b) return;
      const n = source(b, group, { loop: asset.loop !== false, level: !on || on.has(p.name) ? 1 : 0 });
      layers.set(p.name, n); // before start(): a throwing start must still be torn down
      n.src.start(t);
    });
    // Once every layer has ended (a crossfade or stop faded it out), free the whole bed's graph.
    let ended = 0;
    for (const n of layers.values()) {
      n.src.onended = () => {
        if (++ended < layers.size) return;
        for (const m of layers.values()) { try { m.src.disconnect(); m.gain.disconnect(); } catch { /* already disconnected */ } }
        try { group.disconnect(); } catch { /* already disconnected */ }
      };
    }
    const previous = beds[bus];
    beds[bus] = { id, asset, group, layers, startTime: t, state };
    if (bus === 'music') pendingState = null;
    if (previous) stopBed(previous, fadeSec);
    return true;
  }

  /**
   * Fade the current music's layers to a state, now or at the next bar line.
   * @param {string} state
   * @param {{ fadeSec?: number, at?: 'now' | 'bar' }} [o]
   */
  function setState(state, { fadeSec: requested = 1.5, at = 'now' } = {}) {
    const fadeSec = fade(requested);
    const cur = beds.music;
    if (!cur || !ctx) { pendingState = state; return false; }
    const { asset } = cur;
    if (!asset.layers?.length) { warnOnce('E_NOT_ADAPTIVE', `"${cur.id}" has no adaptive layers`, cur.id); return false; }
    const on = asset.states?.[state];
    if (!on) { warnOnce('E_UNKNOWN_STATE', `"${cur.id}" has no state "${state}"`, state); return false; }
    const when = at === 'bar' && asset.bpm ? nextBarTime(cur.startTime, ctx.currentTime, asset.bpm, asset.meter ?? 4, asset.durationSec) : ctx.currentTime;
    for (const [name, n] of cur.layers) {
      const target = on.includes(name) ? 1 : 0;
      const param = n.gain.gain;
      hold(param, when, n.target); // the actual level at `when`, not the previous goal: a fade in progress never snaps
      param.linearRampToValueAtTime(target, when + Math.max(RAMP, fadeSec));
      n.target = target;
    }
    cur.state = state;
    return true;
  }

  /** @param {string} bus @param {number} value */
  function setLevel(bus, value) {
    if (!(bus in levels) || !Number.isFinite(value)) return;
    const b = /** @type {'music' | 'ambience' | 'sfx' | 'master'} */ (bus);
    levels[b] = Math.min(1, Math.max(0, value));
    if (ctx && master && buses) ramp(b === 'master' ? master.gain : buses[b].gain, levels[b]);
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
    if (ctx) for (const n of live.values()) stopNode(n, fadeSec);
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
    await loadCatalog();
    if (!running()) return false;
    await drainPending();
    return running();
  }

  /** Start the beds requested while the context could not run (before unlock, or while hidden). */
  async function drainPending() {
    for (const b of BEDS) {
      const p = pending[b];
      pending[b] = undefined;
      if (p) await bed(b, p.id, { fadeSec: p.fadeSec });
    }
  }

  /** @param {boolean} value */
  function setEnabled(value) {
    enabled = !!value;
    if (!enabled) {
      stopAll();
      if (lifecycle) void lifecycle.setEnabled(false).catch(e => report('E_CONTEXT', text(e)));
    } else if (lifecycle) lifecycle.allow(); // resuming needs a gesture: the next unlock() does it
  }

  /** @param {boolean} value */
  function setHidden(value) {
    hidden = !!value;
    if (!lifecycle) return;
    void lifecycle.setHidden(hidden)
      .then(() => (running() ? drainPending() : undefined))
      .catch(e => report('E_CONTEXT', text(e)));
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
    unlock, play, setState, setLevel, setEnabled, setHidden, stopAll, inspect,
    /** @param {string | null} id @param {{ fadeSec?: number }} [o] */
    music: (id, o) => bed('music', id, o),
    /** @param {string | null} id @param {{ fadeSec?: number }} [o] */
    ambience: (id, o) => bed('ambience', id, o),
  };
}
