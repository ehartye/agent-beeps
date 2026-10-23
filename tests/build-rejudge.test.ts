// 0.32.0: `build` judges a patch's expectations for assets it did not rebuild, from the cached render, because an expectation is not part of the
// asset's input hash: editing one must not re-bake the sound, but it must still be able to fail the build.
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/build/build.ts';
import { chromiumAvailable } from '../src/render/host.ts';
import { coin } from './helpers/patches.ts';
import { makeFixture } from './helpers/build-fixture.ts';

describe.skipIf(!(await chromiumAvailable()))('build and expectations on unchanged assets', () => {
  it('fails an asset it did not rebuild when its expectations no longer hold, and passes again when they do', async () => {
    const fx = makeFixture({ config: { target: 'wav-master' } });
    fx.write('sfx/coin.json', { ...coin(), xExpect: [{ check: 'duration', max: 5 }] });
    const first = await runBuild(fx.cfg(), { only: ['coin'] });
    expect(first.built).toEqual(['coin']);

    // Tightening the brief changes no render key and no input hash, so the asset is "unchanged" ...
    fx.write('sfx/coin.json', { ...coin(), xExpect: [{ check: 'duration', max: 0.01 }] });
    const e = await runBuild(fx.cfg(), { only: ['coin'] }).then(() => undefined, (x: unknown) => x as Error & { code?: string; pointer?: string });
    // ... and the build still refuses it.
    expect(e).toMatchObject({ code: 'E_VERIFY' });
    expect(e!.message).toMatch(/did not need rebuilding no longer meet their expectations: coin: 1 expectation not met \(duration/);

    fx.write('sfx/coin.json', { ...coin(), xExpect: [{ check: 'duration', max: 5 }] });
    const again = await runBuild(fx.cfg(), { only: ['coin'] });
    expect(again.built).toEqual([]);
    expect(again.unchanged).toEqual(['coin']);
  });

  it('does not render for an asset with no expectations, and leaves --check a render-free staleness test', async () => {
    const fx = makeFixture({ config: { target: 'wav-master' } });
    const first = await runBuild(fx.cfg(), { only: ['coin'] });
    expect(first.built).toEqual(['coin']);
    expect((await runBuild(fx.cfg(), { only: ['coin'] })).built).toEqual([]);
    fx.write('sfx/coin.json', { ...coin(), xExpect: [{ check: 'duration', max: 0.01 }] });
    const checked = await runBuild(fx.cfg(), { only: ['coin'], check: true });
    expect(checked.ok).toBe(true);
  });
});
