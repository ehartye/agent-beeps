// The input hash is the product: a missed input is stale audio, a spurious one is a wasted render. No browser, no ffmpeg.
import { describe, expect, it } from 'vitest';
import { loadRecipes, deliveryFor } from '../../src/build/config.ts';
import { currentToolchain } from '../../src/build/lock.ts';
import { planAsset } from '../../src/build/plan.ts';
import { openBuildProject } from '../../src/build/build.ts';
import { makeFixture } from '../helpers/build-fixture.ts';
import { PAD } from '../helpers/songs.ts';

const encoder = { ffmpeg: '6.1.1', libavcodec: 'libavcodec60.31.102' };
function hashes(fx: ReturnType<typeof makeFixture>, o: { target?: string; kbps?: Record<string, number>; encoder?: typeof encoder; toolchain?: Partial<ReturnType<typeof currentToolchain>> } = {}) {
  const cfg = fx.cfg({ target: o.target ?? 'web-universal', ...(o.kbps ? { kbps: o.kbps } : {}) });
  const delivery = deliveryFor(cfg.target, cfg.kbps);
  const p = openBuildProject(cfg);
  const tc = { ...currentToolchain(), ...o.toolchain };
  return Object.fromEntries(loadRecipes(cfg).map(r => [r.id, planAsset(p, r, delivery, tc, delivery.format === 'wav' ? undefined : (o.encoder ?? encoder)).inputHash]));
}
const changed = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).filter(k => a[k] !== b[k]).sort();

describe('input hash', () => {
  it('is the same for the same inputs, in any file order and with any key order', () => {
    const fx = makeFixture(), base = hashes(fx);
    expect(hashes(fx)).toEqual(base);
    expect(Object.values(base).every(h => /^sha256:[0-9a-f]{64}$/.test(h))).toBe(true);
    // The same recipes in another order, and a patch file with its keys reversed: no change.
    const recipes = fx.read('recipes.json');
    fx.write('recipes.json', Object.fromEntries(Object.entries(recipes).reverse()));
    const coin = fx.read('sfx/coin.json');
    fx.write('sfx/coin.json', Object.fromEntries(Object.entries(coin).reverse()));
    expect(hashes(fx)).toEqual(base);
  });

  it('changes for a song when a project patch it uses as an instrument changes, and for nothing else', () => {
    const fx = makeFixture(), base = hashes(fx);
    fx.write('patches/lead.json', { ...PAD, name: 'lead', duration: 2 });
    expect(changed(base, hashes(fx))).toEqual(['theme']); // plain has its own inline pad
  });

  it('changes for a song when an inline instrument changes', () => {
    const fx = makeFixture(), base = hashes(fx);
    const plain = fx.read('songs/plain.json');
    plain.tracks.pad.instrument.layers[0].source.pitch = 'D4';
    fx.write('songs/plain.json', plain);
    expect(changed(base, hashes(fx))).toEqual(['plain']);
  });

  it('is untouched for the other recipes when one recipe changes', () => {
    const fx = makeFixture(), base = hashes(fx);
    fx.write('sfx/blip.json', { ...fx.read('sfx/blip.json'), duration: 0.25 });
    expect(changed(base, hashes(fx))).toEqual(['blip']);
  });

  it('changes only the roles whose bitrate changed', () => {
    const fx = makeFixture(), base = hashes(fx);
    expect(changed(base, hashes(fx, { kbps: { sfx: 64 } }))).toEqual(['blip', 'coin']);
    expect(changed(base, hashes(fx, { kbps: { music: 40 } }))).toEqual(['theme']);
    // The mix bitrate matters only to an adaptive song's preview file.
    expect(changed(base, hashes(fx, { kbps: { mix: 20 } }))).toEqual(['theme']);
  });

  it('changes for every asset when the format, the encoder or the toolchain changes', () => {
    const fx = makeFixture(), base = hashes(fx), all = Object.keys(base).sort();
    expect(changed(base, hashes(fx, { target: 'web-mp3' }))).toEqual(all);
    expect(changed(base, hashes(fx, { target: 'wav-master' }))).toEqual(all);
    expect(changed(base, hashes(fx, { encoder: { ffmpeg: '7.0', libavcodec: 'x' } }))).toEqual(all);
    // The song pipeline is a song's own: a bump leaves the sound effects' hashes alone.
    expect(changed(base, hashes(fx, { toolchain: { songPipeline: 99 } }))).toEqual(['plain', 'theme']);
    expect(changed(base, hashes(fx, { toolchain: { exportPipeline: 99 } }))).toEqual(all);
    expect(changed(base, hashes(fx, { toolchain: { chromium: '999@1' } }))).toEqual(all);
  });

  it('changes for every asset when the project loudness changes', () => {
    const fx = makeFixture(), base = hashes(fx);
    fx.write('project.json', { schema: 'beeps/project@1', targetLoudness: -16, musicLoudness: -18 });
    expect(changed(base, hashes(fx))).toEqual(Object.keys(base).sort());
  });

  it('ignores the source file name', () => {
    const fx = makeFixture(), base = hashes(fx);
    fx.write('sfx/renamed.json', fx.read('sfx/coin.json'));
    fx.write('recipes.json', { ...fx.read('recipes.json'), coin: { source: 'sfx/renamed.json', role: 'sfx' } });
    expect(hashes(fx)).toEqual(base);
  });
});
