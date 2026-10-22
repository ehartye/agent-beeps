import { describe, expect, it } from 'vitest';
import { mapPool, poolSize } from '../src/pool.ts';

const tick = (ms = 1) => new Promise<void>(r => setTimeout(r, ms));

describe('poolSize', () => {
  it('is at least one and at most one per item', () => {
    expect(poolSize(3, 10)).toBe(3);
    expect(poolSize(8, 2)).toBe(2);
    expect(poolSize(0, 5)).toBe(1);
    expect(poolSize(4, 0)).toBe(1);
  });
});

describe('mapPool', () => {
  it('returns results in item order even when items finish out of order', async () => {
    const out = await mapPool([30, 1, 10, 1], 4, async (ms, i) => { await tick(ms); return `${i}:${ms}`; });
    expect(out).toEqual(['0:30', '1:1', '2:10', '3:1']);
  });

  it('never runs more than `jobs` at once and runs them all', async () => {
    let live = 0, peak = 0;
    const out = await mapPool(Array.from({ length: 12 }, (_, i) => i), 3, async n => {
      peak = Math.max(peak, ++live);
      await tick(2);
      live--;
      return n * 2;
    });
    expect(peak).toBe(3);
    expect(out).toEqual(Array.from({ length: 12 }, (_, i) => i * 2));
  });

  it('treats jobs below one as one, and an empty list as nothing to do', async () => {
    let live = 0, peak = 0;
    await mapPool([1, 2, 3], 0, async () => { peak = Math.max(peak, ++live); await tick(); live--; });
    expect(peak).toBe(1);
    expect(await mapPool([], 3, async () => 1)).toEqual([]);
  });

  it('stops claiming after the first rejection, lets in-flight work settle, then throws that error', async () => {
    const started: number[] = [], finished: number[] = [];
    const err = await mapPool([0, 1, 2, 3, 4, 5], 2, async i => {
      started.push(i);
      if (i === 0) { await tick(2); throw new Error('first'); }
      await tick(25);
      finished.push(i);
    }).catch(e => e);
    expect(err.message).toBe('first');
    expect(finished).toEqual([1]); // item 1 was in flight and settled before the throw
    expect(started).not.toContain(5);
  });

  it('opens one scope per worker, runs that worker items inside it, and releases it even on failure', async () => {
    const events: string[] = [];
    let n = 0;
    const scope = async (body: (w: string) => Promise<void>) => {
      const id = `w${n++}`;
      events.push(`open ${id}`);
      try { await body(id); } finally { events.push(`close ${id}`); }
    };
    const used = new Set<string>();
    await mapPool([1, 2, 3, 4, 5, 6], 2, async (_item, _i, w) => { used.add(w); await tick(); }, scope);
    expect(n).toBe(2);
    expect([...used].sort()).toEqual(['w0', 'w1']);
    expect(events.filter(e => e.startsWith('close')).length).toBe(2);

    events.length = 0;
    n = 0;
    await expect(mapPool([1, 2, 3], 3, async x => { if (x === 2) throw new Error('bad'); await tick(5); }, scope)).rejects.toThrow('bad');
    expect(events.filter(e => e.startsWith('open')).length).toBe(3);
    expect(events.filter(e => e.startsWith('close')).length).toBe(3);
  });

  it('rethrows a falsy rejection value', async () => {
    const outcome = await mapPool([1], 1, async () => { throw undefined; }).then(() => 'resolved', e => ({ e }));
    expect(outcome).toEqual({ e: undefined });
  });
});
