// runtime/player/loader.js
// Fetching for the player: the catalog (cached once it loads) and decoded audio buffers (cached,
// shared while in flight). Failures are reported and resolve null; nothing here ever rejects.

/** A failed catalog is retried by retryCatalog() at most once per this many seconds of `now()`. */
export const CATALOG_RETRY_SEC = 5;

/** @typedef {{ ok: boolean, json(): Promise<any>, arrayBuffer(): Promise<ArrayBuffer> }} FetchResponse */

/** A thrown value's message, for onError. @param {unknown} e */
export const text = e => String((/** @type {any} */ (e))?.message ?? e);

/**
 * @template A
 * @param {{
 *   catalog: string | { assets: Record<string, A> },
 *   base: string,
 *   fetcher: (url: string) => Promise<FetchResponse>,
 *   report: (code: string, message: string, id?: string) => void,
 *   now: () => number,
 *   decode: (data: ArrayBuffer) => Promise<AudioBuffer>,
 * }} opts
 */
export function createLoader({ catalog, base, fetcher, report, now, decode }) {
  /** @type {Record<string, A> | null} */
  let assets = null;
  /** @type {Promise<Record<string, A> | null> | null} */
  let catalogLoad = null;
  let retryAt = -Infinity;
  let catalogReported = false; // E_CATALOG once per outage: reset when the catalog loads
  /** @type {Map<string, Promise<AudioBuffer | null>>} */
  const buffers = new Map();
  /** @type {Map<string, number>} */
  const failures = new Map();

  /** The catalog's assets, or null if it could not be loaded (the next call tries again). */
  function loadCatalog() {
    if (assets) return Promise.resolve(assets);
    if (typeof catalog !== 'string') { assets = catalog.assets ?? {}; return Promise.resolve(assets); }
    catalogLoad ??= Promise.resolve()
      .then(() => fetcher(catalog))
      .then(r => { if (!r.ok) throw new Error(`catalog ${catalog} unavailable`); return r.json(); })
      .then(j => { assets = /** @type {Record<string, A>} */ (j?.assets ?? {}); catalogReported = false; return assets; })
      .catch(e => {
        catalogLoad = null;
        if (!catalogReported) { catalogReported = true; report('E_CATALOG', text(e), catalog); }
        return null;
      });
    return catalogLoad;
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
     * A decoded buffer for `file` (relative to `base`), or null. A failed file is retried once on
     * the next call, then stays silent.
     * @param {string} file
     * @returns {Promise<AudioBuffer | null>}
     */
    load(file) {
      const url = base + file;
      const cached = buffers.get(url);
      if (cached) return cached;
      if ((failures.get(url) ?? 0) >= 2) return Promise.resolve(null);
      const p = Promise.resolve()
        .then(() => fetcher(url))
        .then(r => { if (!r.ok) throw new Error(`${url} unavailable`); return r.arrayBuffer(); })
        .then(decode)
        .catch(e => { buffers.delete(url); failures.set(url, (failures.get(url) ?? 0) + 1); report('E_LOAD', text(e), file); return null; });
      buffers.set(url, p);
      return p;
    },
  };
}
