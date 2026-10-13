// The input hash is the product: a missed input is stale audio, a spurious one is a wasted render. No browser, no ffmpeg.
import { describe, expect, it } from 'vitest';
import { loadRecipes, deliveryFor } from '../../src/build/config.ts';
import { currentToolchain } from '../../src/build/lock.ts';
import { planAsset } from '../../src/build/plan.ts';
import { openBuildProject } from '../../src/build/build.ts';
import { makeFixture } from '../helpers/build-fixture.ts';
import { PAD } from '../helpers/songs.ts';
import { canonicalJson, sha256 } from '../../src/hash.ts';

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
  it('keeps the historical export identity exactly when post options are omitted', () => {
    const fx = makeFixture(), cfg = fx.cfg(), p = openBuildProject(cfg);
    for (const recipe of loadRecipes(cfg)) {
      const plan = planAsset(p, recipe, deliveryFor('wav-master'), currentToolchain(), undefined);
      const original = { id: recipe.id, role: recipe.role, kind: recipe.kind, seed: recipe.seed, variants: plan.variants, layers: plan.layers };
      expect(plan.parts.export).toBe(sha256(canonicalJson(original)).slice(0, 12));
    }
    // Captured from unmodified b672196 before the feature: full identities, independent of installed browser metadata.
    expect(hashes(fx, { target: 'wav-master', toolchain: { engine: '2', pipeline: 2, songPipeline: 6, exportPipeline: 1, chromium: 'historical@fixture', playwright: 'fixture', sampleRate: 48000 } })).toEqual({
      blip: 'sha256:e39c5c2829b5029e8497a6aa95214e6e9c108c52c153701d88c98bc6b75a4b4d',
      coin: 'sha256:2717b0a023c2d9bdbc23e670953ab3808b2ffd71da5ba9c74822e4a96e7b4344',
      plain: 'sha256:fc0d5b9745ac9cf4ac7f8f505c1fed7922e81cfa2fe22c82fd80bf6c2f1e71d4',
      theme: 'sha256:2a34a6d212ab39a1ed6b2be3c4acb35f5beb603c907453177c4a0d40e29876a1',
    });
  });

  it('keys patch post options only in export, leaving renders and unrelated assets unchanged', () => {
    const fx = makeFixture(), cfg = fx.cfg(), p = openBuildProject(cfg), tc = currentToolchain();
    const plans = () => Object.fromEntries(loadRecipes(cfg).map(r => [r.id, planAsset(p, r, deliveryFor('wav-master'), tc, undefined)]));
    const base = plans(), recipes = fx.read('recipes.json');
    const optionHashes = new Set<string>();
    for (const options of [{ channels: 1 }, { channels: 2 }, { trimTailDb: -60 }, { trimTailDb: -50 }, { channels: 1, trimTailDb: -60 }]) {
      fx.write('recipes.json', { ...recipes, coin: { ...recipes.coin, ...options } });
      const after = plans();
      expect(after.coin.inputHash).not.toBe(base.coin.inputHash);
      optionHashes.add(after.coin.inputHash);
      expect(after.coin.parts.export).not.toBe(base.coin.parts.export);
      expect({ ...after.coin.parts, export: base.coin.parts.export }).toEqual(base.coin.parts);
      expect(['blip', 'plain', 'theme'].every(id => after[id].inputHash === base[id].inputHash)).toBe(true);
    }
    expect(optionHashes.size).toBe(5);
    fx.write('recipes.json', { ...recipes, coin: { ...recipes.coin, trimTail: -60, trimTailDb: -60 } });
    const bothSpellings = plans().coin.inputHash;
    fx.write('recipes.json', { ...recipes, coin: { ...recipes.coin, trimTailDb: -60 } });
    expect(plans().coin.inputHash).toBe(bothSpellings);
    fx.write('recipes.json', { ...recipes, coin: { ...recipes.coin, channels: 1, trimTailDb: -60 } });
    const canonical = plans().coin;
    fx.write('recipes.json', { ...recipes, coin: { ...recipes.coin, channels: 1, trimTail: -60 } });
    expect(plans().coin.inputHash).toBe(canonical.inputHash);
  });

  it('normalizes the Space spelling and rejects invalid, conflicting, or unsupported post options', () => {
    const fx = makeFixture(), recipe = { source: 'sfx/coin.json', role: 'sfx', variants: 1 };
    fx.write('recipes.json', { coin: { ...recipe, channels: 1, trimTail: -60 } });
    expect(loadRecipes(fx.cfg())[0]).toMatchObject({ channels: 1, trimTailDb: -60 });
    expect(loadRecipes(fx.cfg())[0]).not.toHaveProperty('trimTail');
    for (const extra of [{ channels: 0 }, { channels: 3 }, { channels: '1' }, { trimTailDb: 0 }, { trimTailDb: -121 }, { trimTail: '-60' }, { trimTail: -60, trimTailDb: -50 }, { layers: true, trimTailDb: -60 }, { delivery: 'runtime', channels: 1 }]) {
      fx.write('recipes.json', { coin: { ...recipe, ...extra } });
      expect(() => loadRecipes(fx.cfg())).toThrow();
    }
    for (const extra of [{ channels: 1 }, { trimTailDb: -60 }, { trimTail: -60 }]) {
      fx.write('recipes.json', { plain: { source: 'songs/plain.json', role: 'ambience', ...extra } });
      expect(() => loadRecipes(fx.cfg())).toThrow(/patch/);
    }
  });

  it('rejects baked post options when the patch itself selects runtime-only delivery', () => {
    const fx = makeFixture();
    fx.write('sfx/coin.json', { ...fx.read('sfx/coin.json'), xRuntime: { delivery: 'runtime', inputs: {}, bind: [] } });
    fx.write('recipes.json', { coin: { source: 'sfx/coin.json', role: 'sfx', channels: 1, trimTailDb: -60 } });
    const cfg = fx.cfg(), p = openBuildProject(cfg), [recipe] = loadRecipes(cfg);
    expect(() => planAsset(p, recipe, deliveryFor('wav-master'), currentToolchain(), undefined)).toThrow(/runtime/);
    // A recipe can explicitly override the patch's default to ship a baked file.
    expect(planAsset(p, { ...recipe, delivery: 'baked' }, deliveryFor('wav-master'), currentToolchain(), undefined).ships).toBe('baked');
  });

  it('scopes post options to the baked files when delivery includes a runtime cue', () => {
    const fx = makeFixture(), cfg = fx.cfg(), p = openBuildProject(cfg), tc = currentToolchain();
    const recipe = loadRecipes(cfg).find(r => r.id === 'coin')!;
    const base = planAsset(p, { ...recipe, delivery: 'both' }, deliveryFor('wav-master'), tc, undefined);
    const post = planAsset(p, { ...recipe, delivery: 'both', channels: 1, trimTailDb: -60 }, deliveryFor('wav-master'), tc, undefined);
    expect(post.parts.export).not.toBe(base.parts.export);
    expect({ ...post.parts, export: base.parts.export }).toEqual(base.parts);
  });

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
