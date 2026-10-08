import { describe, expect, it } from 'vitest';
import { verifyingDeterminism, type RenderHost } from '../../src/render/host.ts';
import { BeepsError } from '../../src/errors.ts';
import { song } from '../helpers/songs.ts';

/** A host that "renders" songs into numbered slots and compares them as told; records what was freed. */
function fakeHost(diffs: { differing: number; first: number; maxAbs: number }[]) {
  let id = 0;
  const live = new Set<number>();
  const host = {
    async renderSong() { const n = ++id; live.add(n); return { id: n, sampleRate: 48000, frames: 96000, sections: [] }; },
    async songDiff() { return { ...diffs.shift()!, frames: 96000 }; },
    async freeSong(n: number) { live.delete(n); },
  } as unknown as RenderHost;
  return { host, live };
}

describe('verifyingDeterminism', () => {
  it('renders twice, frees the second render and hands back the first when they are bit-identical', async () => {
    const { host, live } = fakeHost([{ differing: 0, first: -1, maxAbs: 0 }]);
    const r = await verifyingDeterminism(host).renderSong(song(), {});
    expect(r.id).toBe(1);
    expect([...live]).toEqual([1]);
  });

  it('fails with E_NONDETERMINISTIC naming the song, the first sample and the size, and frees both renders', async () => {
    const { host, live } = fakeHost([{ differing: 105644, first: 1920000, maxAbs: 0.0588 }]);
    const err = await verifyingDeterminism(host).renderSong(song({ name: 'mus-desert' }), {}, { only: ['bed'] }).catch(e => e);
    expect(err).toBeInstanceOf(BeepsError);
    expect(err.code).toBe('E_NONDETERMINISTIC');
    expect(err.message).toMatch(/mus-desert \(only bed\).*105644 samples.*frame 1920000 \(40\.000 s\).*5\.88e-2/);
    expect(err.toJson()).toMatchObject({ differingSamples: 105644, firstFrame: 1920000, only: ['bed'] });
    expect(live.size).toBe(0);
  });
});
