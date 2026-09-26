import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../../src/render/host.ts';
import { contactSheet, renderAndMeasure, targetFor, type Rendered } from '../../src/render/pipeline.ts';
import { readWav } from '../../src/audio/wav.ts';
import { momentaryMax } from '../../src/measure/loudness.ts';
import { defaultProject } from '../../src/schema/project.ts';
import { coin, patch, withSource } from '../helpers/patches.ts';

describe.skipIf(!(await chromiumAvailable()))('render pipeline', () => {
  let host: RenderHost;
  const project = defaultProject();
  const rendersDir = mkdtempSync(join(tmpdir(), 'beeps-renders-'));
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  it('trims each sound to its loudness target within 1 LU and writes WAV, features and look', async () => {
    const quiet = patch({ ...coin(), name: 'quiet', layers: [{ ...coin().layers[0], gainDb: -30 }] });
    const noise = withSource({ type: 'noise', color: 'white' });
    const out = await renderAndMeasure(host, [{ patch: coin() }, { patch: quiet }, { patch: noise, seed: 3 }], { project, rendersDir });
    for (const r of out) {
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const { channels, sampleRate } = readWav(readFileSync(r.wavPath));
      expect(momentaryMax(channels, sampleRate)).toBeGreaterThan(targetFor(r.patch, project) - 1);
      expect(momentaryMax(channels, sampleRate)).toBeLessThan(targetFor(r.patch, project) + 1);
      expect(r.features.delivered.truePeakDb).toBeLessThan(0);
      expect(readFileSync(r.lookPath).subarray(1, 4).toString()).toBe('PNG');
    }
    const [loud, soft] = out as Rendered[];
    expect(soft.trimDb - loud.trimDb).toBeCloseTo(30, 0);
  });

  it('caps the trim for spiky sounds so the true peak stays under the ceiling', async () => {
    const click = withSource({ type: 'modal', pitch: 2000, modes: [[1, 8, 0], [2.3, 10, -6]], exciter: 'impulse' }, { amp: { attack: 0.0005, decay: 0.01, release: 0.005 } });
    const [r] = await renderAndMeasure(host, [{ patch: { ...click, family: 'ui-click', duration: 0.02 } }], { project, rendersDir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.features.delivered.peakLimited).toBe(true);
    expect(r.features.delivered.truePeakDb).toBeLessThanOrEqual(-1.3);
  });

  it('serves repeat renders from the cache', async () => {
    const [a] = await renderAndMeasure(host, [{ patch: coin() }], { project, rendersDir });
    const [b] = await renderAndMeasure(host, [{ patch: coin() }], { project, rendersDir });
    expect(a.ok && b.ok && a.key === b.key && a.trimDb === b.trimDb).toBe(true);
  });

  it('reports a silent patch as an item error', async () => {
    const silent = patch({ ...coin(), name: 'silent', layers: [{ ...coin().layers[0], gainDb: -60, filter: { type: 'lowpass', cutoff: 5, resonanceDb: 0 } }] });
    const [r] = await renderAndMeasure(host, [{ patch: silent }], { project, rendersDir });
    expect(r.ok).toBe(false);
  });

  it('draws a labelled contact sheet', async () => {
    const out = (await renderAndMeasure(host, [{ patch: coin() }, { patch: coin(), seed: 2 }], { project, rendersDir })) as Rendered[];
    const path = await contactSheet(host, out, ['1', '2'], join(rendersDir, 'sheet.png'));
    expect(existsSync(path)).toBe(true);
  });
});
