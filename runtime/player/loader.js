// runtime/player/loader.js
// Fetching for the player: the catalog (cached once it loads) and decoded audio buffers (cached,
// shared while in flight; optionally kept under a byte budget by least-recently-used eviction of
// buffers nothing holds). Failures are reported and resolve null; nothing here ever rejects.

/** A failed catalog is retried by retryCatalog() at most once per this many seconds of `now()`. */
export const CATALOG_RETRY_SEC = 5;

/** A buffer reloaded within this many seconds of `now()` after its budget eviction counts as thrashing. */
export const THRASH_SEC = 30;

/** @typedef {{ ok: boolean, json(): Promise<any>, arrayBuffer(): Promise<ArrayBuffer> }} FetchResponse */

/** A thrown value's message, for onError. @param {unknown} e */
export const text = e => String((/** @type {any} */ (e))?.message ?? e);

/**
 * How many background (prefetch) loads run at once when the game does not say: one on a phone or
 * tablet, two elsewhere.
 * @param {any} [nav]
 */
export function defaultPrefetchConcurrency(nav = typeof navigator === 'undefined' ? undefined : navigator) {
  if (!nav) return 2;
  const phone = nav.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobi/i.test(nav.userAgent ?? '')
    || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1); // iPadOS reports itself as a Mac
  return phone ? 1 : 2;
}

/** Decoded size in bytes (32-bit float samples), or `fallback` for a buffer that does not say. @param {any} b @param {number} fallback */
const sizeOf = (b, fallback) => {
  const n = b?.length * b?.numberOfChannels * 4;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * @typedef {{ url: string, file: string, promise: Promise<AudioBuffer | null>, bytes: number, est: number,
 *   loaded: boolean, started: boolean, last: number, prefetch: boolean, slot: 'fg' | 'bg' | null,
 *   wake: (() => void) | null, drop: boolean }} Entry
 */

/**
 * @template A
 * @param {{
 *   catalog: string | { assets: Record<string, A> },
 *   base: string,
 *   fetcher: (url: string) => Promise<FetchResponse>,
 *   report: (code: string, message: string, id?: string) => void,
 *   now: () => number,
 *   decode: (data: ArrayBuffer) => Promise<AudioBuffer>,
 *   budgetBytes?: number,
 *   prefetchConcurrency?: number,
 * }} opts
 */
export function createLoader({ catalog, base, fetcher, report, now, decode, budgetBytes = Infinity, prefetchConcurrency = defaultPrefetchConcurrency() }) {
  const budget = typeof budgetBytes === 'number' && budgetBytes >= 0 ? budgetBytes : Infinity; // NaN, negative or a non-number: no budget
  const cap = Math.max(1, Math.floor(prefetchConcurrency) || 1);
  /** @type {Record<string, A> | null} */
  let assets = null;
  /** @type {Promise<Record<string, A> | null> | null} */
  let catalogLoad = null;
  let retryAt = -Infinity;
  let catalogReported = false; // E_CATALOG once per outage: reset when the catalog loads
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  /** Holds per url: a held buffer is in use (playing, scheduled, or about to start) and is never evicted. @type {Map<string, number>} */
  const holds = new Map();
  /** When each budget-evicted url was evicted, to spot a reload that follows right behind it. @type {Map<string, number>} */
  const evictedAt = new Map();
  /** @type {Set<string>} */
  const thrashReported = new Set();
  /** Background loads waiting for a slot. @type {Entry[]} */
  const waiting = [];
  let fg = 0, bg = 0; // loads running now: foreground (the player is waiting) and background (prefetch)
  let decodedBytes = 0, reservedBytes = 0, tick = 0, overReported = false;
  const stats = { evictions: 0, unloads: 0, reloads: 0, thrash: 0, skippedPrefetch: 0, peakBytes: 0 };
  /** @type {Map<string, number>} */
  const failures = new Map();
  let generation = 0; // bumped by reset(): a failure from before it does not count against later attempts

  /** The catalog's assets, or null if it could not be loaded (the next call tries again). */
  function loadCatalog() {
    if (assets) return Promise.resolve(assets);
    if (typeof catalog !== 'string') { assets = catalog.assets ?? {}; return Promise.resolve(assets); }
    catalogLoad ??= Promise.resolve()
      .then(() => fetcher(catalog))
      .then(r => { if (!r.ok) throw new Error(`catalog ${catalog} unavailable`); return r.json(); })
      .then(j => {
        if (!j || typeof j.assets !== 'object' || j.assets === null || Array.isArray(j.assets)) {
          throw new Error(`${catalog}: not a beeps audio catalog (no "assets" object)`);
        }
        assets = /** @type {Record<string, A>} */ (j.assets);
        catalogReported = false;
        return assets;
      })
      .catch(e => {
        catalogLoad = null;
        if (!catalogReported) { catalogReported = true; report('E_CATALOG', text(e), catalog); }
        return null;
      });
    return catalogLoad;
  }

  /** @param {Entry} e */
  const touch = e => { e.last = ++tick; };

  /** Give back an entry's load slot and reservation. @param {Entry} e */
  function free(e) {
    if (e.slot === 'fg') fg--; else if (e.slot === 'bg') bg--;
    e.slot = null;
    if (e.started) { reservedBytes -= e.est; e.started = false; }
    pump();
  }

  /** Background loads start only while no foreground load runs, up to the cap: prefetch never competes with a load the player is waiting for. */
  function pump() {
    while (waiting.length && fg === 0 && bg < cap) {
      const e = /** @type {Entry} */ (waiting.shift());
      e.slot = 'bg'; bg++;
      /** @type {() => void} */ (e.wake)();
    }
  }

  /** A foreground load wants this background one: run it now, ahead of the queue and the cap. @param {Entry} e */
  function promote(e) {
    if (!e.prefetch) return;
    e.prefetch = false;
    if (e.slot === 'bg') { bg--; fg++; e.slot = 'fg'; return; }
    const i = waiting.indexOf(e);
    if (i < 0) return;
    waiting.splice(i, 1);
    e.slot = 'fg'; fg++;
    /** @type {() => void} */ (e.wake)();
  }

  /** @param {Entry} e @returns {Promise<void>} resolves when it may start */
  function acquire(e) {
    if (!e.prefetch) { e.slot = 'fg'; fg++; return Promise.resolve(); }
    return new Promise(resolve => { e.wake = resolve; waiting.push(e); pump(); });
  }

  /** The least recently used decoded buffer nothing holds, other than `keep`. @param {Entry | null} keep */
  function victim(keep) {
    /** @type {Entry | null} */
    let v = null;
    for (const e of entries.values()) if (e.loaded && e !== keep && !holds.get(e.url) && (!v || e.last < v.last)) v = e;
    return v;
  }

  /** @param {Entry} e @param {boolean} byBudget */
  function remove(e, byBudget) {
    if (entries.get(e.url) === e) entries.delete(e.url);
    if (e.loaded) decodedBytes -= e.bytes;
    if (byBudget) { stats.evictions++; evictedAt.set(e.url, now()); } else stats.unloads++;
  }

  /**
   * Evict least-recently-used buffers nothing holds until decoded plus reserved bytes fit the budget.
   * Reports once when only held buffers are left over it.
   * @param {Entry | null} [keep] @returns {boolean} whether it fits
   */
  function makeRoom(keep = null) {
    if (budget === Infinity) return true;
    while (decodedBytes + reservedBytes > budget) {
      const v = victim(keep);
      if (!v) {
        if (!overReported) {
          overReported = true;
          report('W_MEMORY_BUDGET', `decoded audio is ${decodedBytes + reservedBytes} bytes, over the ${budget} byte budget, and everything left is playing or about to play`);
        }
        return false;
      }
      remove(v, true);
    }
    overReported = false;
    return true;
  }

  /** A load right behind a budget eviction is thrashing: the budget is too small for what the game keeps switching between. @param {string} url @param {string} file */
  function noteReload(url, file) {
    const at = evictedAt.get(url);
    if (at === undefined) return;
    evictedAt.delete(url);
    stats.reloads++;
    if (now() - at >= THRASH_SEC) return;
    stats.thrash++;
    if (thrashReported.has(url)) return;
    thrashReported.add(url);
    report('W_MEMORY_THRASH', `"${file}" was evicted and is needed again ${(now() - at).toFixed(1)} s later: raise memoryBudgetBytes or prefetch less`, file);
  }

  /** @param {Entry} e @param {number} gen @returns {Promise<AudioBuffer | null>} */
  async function run(e, gen) {
    try {
      await acquire(e);
      // Make room before the decode allocates, so the peak stays near the budget. A background load
      // that cannot fit is skipped; a foreground one goes ahead (makeRoom has reported it).
      e.started = true; reservedBytes += e.est;
      if (!makeRoom(e) && e.prefetch) {
        stats.skippedPrefetch++;
        free(e);
        if (entries.get(e.url) === e) entries.delete(e.url);
        return null;
      }
      noteReload(e.url, e.file);
      const r = await fetcher(e.url);
      if (!r.ok) throw new Error(`${e.url} unavailable`);
      const buffer = await decode(await r.arrayBuffer());
      free(e);
      e.bytes = sizeOf(buffer, e.est); e.loaded = true;
      decodedBytes += e.bytes;
      stats.peakBytes = Math.max(stats.peakBytes, decodedBytes);
      failures.delete(e.url);
      if (e.drop && !holds.get(e.url)) remove(e, false); // unload() asked while it was loading
      else makeRoom();
      return buffer;
    } catch (err) {
      free(e);
      if (entries.get(e.url) === e) entries.delete(e.url);
      if (gen === generation) failures.set(e.url, (failures.get(e.url) ?? 0) + 1);
      report('E_LOAD', text(err), e.file);
      return null;
    }
  }

  return {
    get assets() { return assets; },
    catalog: loadCatalog,
    /** Retry a failed catalog without waiting, at most once per CATALOG_RETRY_SEC: safe to call every frame. */
    retryCatalog() {
      if (assets || catalogLoad || now() < retryAt) return;
      retryAt = now() + CATALOG_RETRY_SEC;
      void loadCatalog();
    },
    /**
     * Forget past failures so the next catalog() / retryCatalog() / load() fetches and reports again
     * (e.g. when the player offers "toggle sound to try again"). Decoded buffers, a loaded catalog and
     * loads in flight are kept.
     */
    reset() {
      failures.clear();
      retryAt = -Infinity;
      catalogReported = false;
      thrashReported.clear();
      generation++;
    },
    /**
     * A decoded buffer for `file` (relative to `base`), or null. A failed file is retried once on
     * the next call, then stays silent until reset(). A buffer evicted under the budget loads again
     * on the next call. `bytes` is the expected decoded size, used to make room before decoding;
     * `prefetch` queues a background load (see defaultPrefetchConcurrency) that a plain load() of
     * the same file promotes.
     * @param {string} file
     * @param {{ bytes?: number, prefetch?: boolean }} [o]
     * @returns {Promise<AudioBuffer | null>}
     */
    load(file, { bytes = 0, prefetch = false } = {}) {
      const url = base + file;
      const cached = entries.get(url);
      if (cached) {
        touch(cached);
        cached.drop = false;
        if (!prefetch) promote(cached);
        return cached.promise;
      }
      if ((failures.get(url) ?? 0) >= 2) return Promise.resolve(null);
      /** @type {Entry} */
      const e = { url, file, promise: Promise.resolve(null), bytes: 0, est: bytes > 0 ? bytes : 0, loaded: false, started: false, last: 0, prefetch, slot: null, wake: null, drop: false };
      touch(e);
      entries.set(url, e);
      e.promise = run(e, generation);
      return e.promise;
    },
    /**
     * Mark `file` in use until the returned function is called (idempotent): a held buffer is never
     * evicted or unloaded. Hold before load() and release when the sound has ended.
     * @param {string} file
     */
    hold(file) {
      const url = base + file;
      holds.set(url, (holds.get(url) ?? 0) + 1);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const n = (holds.get(url) ?? 1) - 1;
        if (n > 0) holds.set(url, n); else holds.delete(url);
        const e = entries.get(url);
        if (e) {
          touch(e); // just used: the last to go
          if (e.drop && n <= 0 && e.loaded) remove(e, false);
        }
        makeRoom();
      };
    },
    /**
     * Drop the decoded buffer for `file` so its memory can be reclaimed. Skipped while held. A load in
     * flight finishes for whoever waits on it, then is dropped. Returns the bytes freed now.
     * @param {string} file
     */
    unload(file) {
      const e = entries.get(base + file);
      if (!e || holds.get(e.url)) return 0;
      if (!e.loaded) { e.drop = true; return 0; }
      const bytes = e.bytes;
      remove(e, false);
      return bytes;
    },
    /** Decoded-memory numbers for telemetry and tests. */
    memory() {
      let buffers = 0, loading = 0, pinnedBuffers = 0, pinnedBytes = 0;
      for (const e of entries.values()) {
        if (!e.loaded) { loading++; continue; }
        buffers++;
        if (holds.get(e.url)) { pinnedBuffers++; pinnedBytes += e.bytes; }
      }
      return { budgetBytes: budget === Infinity ? null : budget, decodedBytes, buffers, loading, pinnedBuffers, pinnedBytes, ...stats };
    },
  };
}
