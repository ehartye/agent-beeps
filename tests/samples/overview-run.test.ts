import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { writeWav } from '../../src/audio/wav.ts';
import { initProject, openProject } from '../../src/project.ts';
import { runOverview } from '../../src/samples/overview-run.ts';
import { importSample } from '../../src/samples/prepare.ts';
import type { RenderHost } from '../../src/render/host.ts';
import { SR, sine } from '../helpers/signals.ts';

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'beeps-overview-run-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A render host that records its calls and needs no browser. */
const fake = (look: () => Promise<Buffer> = async () => png) => {
  const songPcmLook = vi.fn(look), close = vi.fn(async () => {});
  const host = { songPcmLook, close } as unknown as RenderHost;
  return { songPcmLook, close, open: vi.fn(async () => host) };
};
const audio = () => {
  const pcm = new Float32Array(12 * SR);
  for (const t of [1, 4, 8]) pcm.set(sine(440, 0.5), t * SR);
  return pcm;
};
const wavFile = (d: string, name = 'long.wav', pcm = audio()) => { const f = join(d, name); writeFileSync(f, writeWav([pcm], SR, { bits: 32 })); return f; };
const req = (source: string, projectDir: string, extra: object = {}) => ({ source, projectDir, gapDb: 40, minGapMs: 200, image: true, ...extra });

describe('runOverview image', () => {
  it('writes to renders/overviews/<12 hex>.png in the project, with the same key for a file and its imported ID', async () => {
    const d = dir(); initProject(d);
    const file = wavFile(d), host = fake();
    const byFile = await runOverview(req(file, d), host.open);
    const id = importSample(openProject(d), file).normalizedId;
    const byId = await runOverview(req(id, d), host.open);
    const renders = openProject(d).paths.renders;
    expect(dirname(byFile.image!)).toBe(join(renders, 'overviews'));
    expect(basename(byFile.image!)).toMatch(/^[0-9a-f]{12}\.png$/);
    expect(byId.image).toBe(byFile.image);
    expect(existsSync(byFile.image!)).toBe(true);
    const again = await runOverview(req(file, d), host.open);
    expect(again.image).toBe(byFile.image);
    expect(host.close).toHaveBeenCalledTimes(3);
  });

  it('keys the image by the view and the gap settings', async () => {
    const d = dir(); initProject(d);
    const file = wavFile(d), host = fake();
    const images = new Set([await runOverview(req(file, d), host.open), await runOverview(req(file, d, { startSec: 2 }), host.open),
      await runOverview(req(file, d, { gapDb: 30 }), host.open), await runOverview(req(file, d, { minGapMs: 300 }), host.open)].map(r => r.image));
    expect(images.size).toBe(4);
  });

  it('keys the image by the audio too', async () => {
    const d = dir(); initProject(d);
    const other = audio(); other.set(sine(880, 0.5), 8 * SR);
    const host = fake();
    const a = await runOverview(req(wavFile(d, 'a.wav'), d), host.open), b = await runOverview(req(wavFile(d, 'b.wav', other), d), host.open);
    expect(b.image).not.toBe(a.image);
  });

  it('hands the renderer the view window, not just a view-sized slice', async () => {
    const d = dir(), host = fake(), pcm = new Float32Array(5 * SR);
    pcm.set(sine(440, 0.1), 2 * SR); // 1 s into a view of 1 s to 4 s
    await runOverview(req(wavFile(d, 'pos.wav', pcm), d, { out: join(d, 'o.png'), startSec: 1, endSec: 4 }), host.open);
    const [channels] = host.songPcmLook.mock.calls[0] as unknown as [Float32Array[]];
    expect(channels[0]).toHaveLength(3 * SR);
    expect(channels[0].findIndex(v => v !== 0)).toBeGreaterThanOrEqual(SR);
    expect(channels[0].findIndex(v => v !== 0)).toBeLessThanOrEqual(SR + 2);
    expect(Math.max(...channels[0].subarray(SR, SR + 4800).map(Math.abs))).toBeGreaterThan(0.4);
  });

  it('creates the parent directory of --out, even without a project', async () => {
    const d = dir(), out = join(d, 'a', 'b', 'o.png');
    const r = await runOverview(req(wavFile(d), d, { out }), fake().open);
    expect(r.image).toBe(out);
    expect(existsSync(out)).toBe(true);
  });

  it('closes the host and leaves no file or directory when the render throws', async () => {
    const d = dir(), out = join(d, 'new', 'o.png'), host = fake(async () => { throw new Error('boom'); });
    await expect(runOverview(req(wavFile(d), d, { out }), host.open)).rejects.toThrow('boom');
    expect(host.close).toHaveBeenCalledTimes(1);
    expect(existsSync(join(d, 'new'))).toBe(false);
    initProject(d);
    await expect(runOverview(req(wavFile(d), d), host.open)).rejects.toThrow('boom');
    expect(existsSync(join(openProject(d).paths.renders, 'overviews'))).toBe(false);
  });

  it('never opens the host without an image', async () => {
    const d = dir(), host = fake();
    const r = await runOverview(req(wavFile(d), d, { image: false }), host.open);
    expect(r.image).toBeNull();
    expect(host.open).not.toHaveBeenCalled();
  });

  it('hands the renderer the numbered sections, arc and source of the overview', async () => {
    const d = dir(), host = fake();
    const r = await runOverview(req(wavFile(d), d, { out: join(d, 'o.png'), startSec: 3 }), host.open);
    const [channels, features, label] = host.songPcmLook.mock.calls[0] as unknown as [Float32Array[], { sections: { name: string; start: number }[]; arc: number[]; source: { startSec: number; endSec: number; peakDb: number | null } }, string];
    expect(channels[0]).toHaveLength(9 * SR);
    expect(features.sections.map(s => s.name)).toEqual(['1', '2']);
    expect(features.sections[0].start).toBeCloseTo(0.98, 6);
    expect(features.arc.length).toBeGreaterThan(0);
    expect(features.source).toMatchObject({ startSec: 3, endSec: 12 });
    expect(features.source.peakDb).toBeCloseTo(-6, 0);
    expect(label).toBe('long.wav');
    expect(r.segments.map(s => s.index)).toEqual([1, 2]);
  });
});

describe('runOverview arguments', () => {
  const bad = (code: string, d: string, source: string, extra: object) =>
    expect(runOverview(req(source, d, { image: false, ...extra }), fake().open)).rejects.toMatchObject({ code });
  const cases: [string, object][] = [
    ['--start beyond the source', { startSec: 13 }], ['--start negative', { startSec: -1 }], ['--end zero', { endSec: 0 }],
    ['--end before --start', { startSec: 5, endSec: 2 }], ['--end beyond the source', { endSec: 13 }],
    ['--gap-db zero', { gapDb: 0 }], ['--gap-db above 100', { gapDb: 101 }], ['--min-gap under 10 ms', { minGapMs: 5 }],
    ['--start NaN', { startSec: NaN }], ['--end NaN', { endSec: NaN }], ['--end Infinity', { endSec: Infinity }], ['--start Infinity', { startSec: Infinity }],
    ['--gap-db NaN', { gapDb: NaN }], ['--min-gap NaN', { minGapMs: NaN }],
  ];
  it.each(cases)('rejects %s with E_SCHEMA before drawing', async (_name, extra) => {
    const d = dir();
    await bad('E_SCHEMA', d, wavFile(d), extra);
  });

  it('rejects a malformed sample ID with E_SCHEMA, with or without a project', async () => {
    const d = dir();
    await bad('E_SCHEMA', d, 'sha256:abc', {});
    initProject(d);
    await bad('E_SCHEMA', d, 'sha256:abc', {});
  });

  it('rejects --out without an image with E_USAGE', async () => {
    const d = dir();
    await bad('E_USAGE', d, wavFile(d), { out: join(d, 'x.png') });
  });

  it('checks --out against --no-image before it looks for a project, so an ID without one is E_USAGE', async () => {
    const d = dir(), id = `sha256:${'0'.repeat(64)}`;
    await bad('E_USAGE', d, id, { out: join(d, 'x.png') });
    await bad('E_PROJECT', d, id, {});
  });
});
