import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../../src/render/host.ts';
import { renderAndMeasure } from '../../src/render/pipeline.ts';
import { defaultProject } from '../../src/schema/project.ts';
import { writeSampleObject } from '../../src/samples/store.ts';
import { sampleFixture } from '../helpers/samples.ts';
import { coin } from '../helpers/patches.ts';
import { writeWav } from '../../src/audio/wav.ts';
import { sampleId } from '../../src/samples/store.ts';

describe.skipIf(!(await chromiumAvailable()))('production sample transport', () => {
  let host: RenderHost;
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });
  it('renders exact stereo PCM at the layer onset and a hybrid through the production host', async () => {
    const f = sampleFixture(), hybrid = sampleFixture({ hybrid: true });
    const [r, h] = await host.render([{ patch: f.patch, opts: { sampleWavs: f.sampleWavs } }, { patch: hybrid.patch, opts: { sampleWavs: hybrid.sampleWavs } }]);
    expect(r.ok && h.ok).toBe(true);
    if (!r.ok || !h.ok) return;
    for (let c = 0; c < 2; c++) {
      expect(r.authored[c].subarray(0, 600).every(x => x === 0)).toBe(true);
      expect(r.authored[c].slice(600, 600 + f.pcm[c].length)).toEqual(f.pcm[c]);
    }
    expect(h.authored[0]).not.toEqual(r.authored[0]);
  });
  it('fails malformed, missing and corrupt transports per item, preserving valid neighbors', async () => {
    const f = sampleFixture();
    const out = await host.render([
      { patch: coin(), opts: {} }, { patch: f.patch, opts: {} },
      { patch: f.patch, opts: { sampleWavs: { [f.id]: '!' } } },
      { patch: f.patch, opts: { sampleWavs: { [f.id]: Buffer.from('wrong').toString('base64') } } },
      { patch: f.patch, opts: { sampleWavs: f.sampleWavs } },
    ]);
    expect(out.map(r => r.ok)).toEqual([true, false, false, false, true]);
  });
  it('accepts the full ten-second stereo canonical WAV bound without a regex stack overflow', async () => {
    const pcm = [0, 1].map(c => Float32Array.from({ length: 480000 }, (_, i) => (i % 8 - 4) / (32 + c * 32)));
    const wav = writeWav(pcm, 48000, { bits: 32 }), id = sampleId(wav), f = sampleFixture();
    f.patch.duration = 10;
    f.patch.layers[0].start = 0;
    f.patch.layers[0].source = { type: 'sample', asset: id };
    const [r] = await host.render([{ patch: f.patch, opts: { sampleWavs: { [id]: wav.toString('base64') } } }]);
    expect(r.ok, !r.ok ? r.error : '').toBe(true);
    if (r.ok) for (let c = 0; c < 2; c++) expect(r.authored[c].slice(0, 480000)).toEqual(pcm[c]);
  });
  it('verifies source bytes before warm cache reuse and preserves unrelated items', async () => {
    const f = sampleFixture(), dir = mkdtempSync(join(tmpdir(), 'beeps-sample-pipeline-'));
    const sampleObjectsDir = join(dir, 'objects'), stored = writeSampleObject(sampleObjectsDir, f.wav);
    const options = { project: defaultProject(), rendersDir: join(dir, 'renders'), sampleObjectsDir };
    const [first] = await renderAndMeasure(host, [{ patch: f.patch }], options);
    expect(first.ok).toBe(true);
    const render = vi.spyOn(host, 'render');
    const [warm] = await renderAndMeasure(host, [{ patch: f.patch }], options);
    expect(warm.ok && first.ok && warm.key === first.key).toBe(true);
    expect(render).not.toHaveBeenCalled();
    unlinkSync(stored.path);
    const [missing, good] = await renderAndMeasure(host, [{ patch: f.patch }, { patch: coin() }], options);
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
    expect(good.ok).toBe(true);
    writeFileSync(stored.path, Buffer.alloc(f.wav.length));
    const [corrupt] = await renderAndMeasure(host, [{ patch: f.patch }], options);
    expect(corrupt).toMatchObject({ ok: false, error: expect.stringMatching(/hash mismatch/) });
    render.mockRestore();
  });
  it('requires explicit store context for a sample and does not require one for a procedural patch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-no-sample-context-'));
    const out = await renderAndMeasure(host, [{ patch: sampleFixture().patch }, { patch: coin() }], { project: defaultProject(), rendersDir: dir });
    expect(out[0]).toMatchObject({ ok: false, error: expect.stringMatching(/sample.*(store|objects|context)/i) });
    expect(out[1].ok).toBe(true);
  });
});
