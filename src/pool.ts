// A bounded worker pool: map items through an async function with at most `jobs` in flight.

/** How many workers to start: at least one, at most one per item. */
export const poolSize = (jobs: number, items: number): number => Math.max(1, Math.min(jobs, items));

/**
 * Open a resource for one worker, hand it to `body`, and release it afterwards (a render host, say). Each worker calls it once and
 * runs every item it claims inside `body`.
 */
export type PoolScope<W> = (body: (worker: W) => Promise<void>) => Promise<void>;

/**
 * Map `items` through `fn` with at most `jobs` running at once. Results are in item order whatever order they finish in.
 * Workers claim the next unclaimed item, so a slow item never holds up the rest. After the first rejection no further items
 * are claimed; work already in flight settles (and each worker's `scope` is released), then that first error is thrown.
 * `scope`: per-worker setup and teardown; `fn` gets its resource as the third argument.
 */
export async function mapPool<T, R, W = undefined>(items: readonly T[], jobs: number, fn: (item: T, index: number, worker: W) => Promise<R>, scope?: PoolScope<W>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0, failed = false, error: unknown;
  const loop = async (worker: W) => {
    while (!failed && next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i, worker);
    }
  };
  const run = async () => {
    try { await (scope ? scope(loop) : loop(undefined as W)); }
    catch (e) { if (!failed) { failed = true; error = e; } }
  };
  if (items.length) await Promise.all(Array.from({ length: poolSize(jobs, items.length) }, run));
  if (failed) throw error;
  return out;
}
