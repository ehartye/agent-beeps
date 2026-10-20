import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../../src/audio/wav.ts';
import { findFfmpeg } from '../../src/compress.ts';
import { initProject } from '../../src/project.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { sampleId } from '../../src/samples/store.ts';
import { SR, sine } from '../helpers/signals.ts';

const hasChromium = await chromiumAvailable();
const hasFfmpeg = (() => { try { findFfmpeg(); return true; } catch { return false; } })();
const bin = join(import.meta.dirname, '../../scripts/beeps.mjs'), dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'beeps-overview-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const cli = (cwd: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  const json = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  return { status: r.status, out: json(r.stdout), err: json(r.stderr)?.error, stderr: r.stderr };
};
const layout = (total: number, parts: [number, Float32Array][]) => {
  const out = new Float32Array(Math.round(total * SR));
  for (const [t, x] of parts) out.set(x, Math.round(t * SR));
  return out;
};
// Each segment starts 20 ms before its onset (the lead-in), so bursts at 1, 4 and 8 s begin at 0.98, 3.98 and 7.98 s.
const long = () => layout(12, [[1, sine(440, 0.5)], [4, sine(660, 0.5)], [8, sine(880, 0.5)]]);
const write = (d: string, name: string, pcm: Float32Array) => { const f = join(d, name); writeFileSync(f, writeWav([pcm], SR, { bits: 32 })); return f; };

describe('beeps sample overview', () => {
  it('overviews a file with no project and names the ID import will give it', () => {
    const d = dir(), pcm = long(), file = write(d, 'long.wav', pcm);
    const r = cli(d, 'sample', 'overview', file, '--no-image');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.image).toBeNull();
    expect(r.out.source).toMatchObject({ file: 'long.wav', durationSec: 12, channels: 1, sampleRate: 48000, normalizedId: sampleId(writeWav([pcm], SR, { bits: 32 })) });
    expect(r.out.segments.map((s: { startSec: number }) => s.startSec)).toEqual([0.98, 3.98, 7.98]);
    expect(r.out.hints.join(' ')).toMatch(/sample import/);
  });

  it('agrees with import, and its prepare lines run and give the segment frames', () => {
    const d = dir(); initProject(d);
    const file = write(d, 'long.wav', long());
    const imported = cli(d, 'sample', 'import', file).out;
    const byFile = cli(d, 'sample', 'overview', file, '--no-image').out;
    expect(byFile.source.normalizedId).toBe(imported.normalizedId);
    const byId = cli(d, 'sample', 'overview', imported.normalizedId, '--no-image');
    expect(byId.status, byId.stderr).toBe(0);
    expect(byId.out.source).toMatchObject({ normalizedId: imported.normalizedId });
    expect(byId.out.source.file).toBeUndefined();
    expect(byId.out.segments).toHaveLength(3);
    expect(byFile.segments).toEqual(byId.out.segments);
    for (const s of byId.out.segments) {
      const m = /^beeps sample prepare (sha256:[0-9a-f]{64}) --start (\S+) --end (\S+)$/.exec(s.prepare);
      expect(m, s.prepare).not.toBeNull();
      const [, id, start, end] = m!;
      expect(id).toBe(imported.normalizedId);
      const p = cli(d, 'sample', 'prepare', id, '--start', start, '--end', end);
      expect(p.status, p.stderr).toBe(0);
      expect(p.out.receipt.recipe).toMatchObject({ startFrame: s.startFrame, endFrame: s.endFrame });
    }
  });

  it('limits the view with --start and --end in source time', () => {
    const d = dir(), file = write(d, 'long.wav', long());
    const r = cli(d, 'sample', 'overview', file, '--no-image', '--start', '3', '--end', '9');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.source.view).toEqual({ startSec: 3, endSec: 9 });
    expect(r.out.segments.map((s: { startSec: number }) => s.startSec)).toEqual([3.98, 7.98]);
  });

  // One process per error family and per command-level number parse; the rest of the argument matrix runs in-process in overview-run.test.ts.
  it('rejects bad arguments with the right error code', () => {
    const d = dir(), file = write(d, 'long.wav', long());
    for (const args of [['--start', 'NaN'], ['--min-gap', 'x']]) {
      const r = cli(d, 'sample', 'overview', file, '--no-image', ...args);
      expect(r.status, JSON.stringify(args)).not.toBe(0);
      expect(r.err.code, JSON.stringify(args)).toBe('E_SCHEMA');
      expect(r.err.message, JSON.stringify(args)).toMatch(`${args[0]} must be a finite number`);
    }
    expect(cli(d, 'sample', 'overview', join(d, 'missing.wav'), '--no-image').err.code).toBe('E_NOT_FOUND');
    expect(cli(d, 'sample', 'overview', file).err.code).toBe('E_USAGE'); // image wanted, no project, no --out
  });

  it('needs a project for an ID and refuses an unknown one', () => {
    const d = dir(), id = `sha256:${'0'.repeat(64)}`;
    expect(cli(d, 'sample', 'overview', id, '--no-image').err.code).toBe('E_PROJECT');
    initProject(d);
    expect(cli(d, 'sample', 'overview', id, '--no-image').err.code).toBe('E_NOT_FOUND');
  });

  it('agrees with import on a stereo file', () => {
    const d = dir(); initProject(d);
    const file = join(d, 'stereo.wav');
    writeFileSync(file, writeWav([long(), layout(12, [[2, sine(330, 0.5)]])], SR, { bits: 32 }));
    const imported = cli(d, 'sample', 'import', file).out;
    const r = cli(d, 'sample', 'overview', file, '--no-image');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.source).toMatchObject({ channels: 2, normalizedId: imported.normalizedId });
  });

  it.skipIf(!hasFfmpeg)('agrees with import on a 44.1 kHz file that ffmpeg resamples', () => {
    const d = dir(); initProject(d);
    const file = join(d, 'cd.wav');
    writeFileSync(file, writeWav([sine(440, 3)], 44100, { bits: 16 }));
    const imported = cli(d, 'sample', 'import', file);
    expect(imported.status, imported.stderr).toBe(0);
    const r = cli(d, 'sample', 'overview', file, '--no-image');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.source).toMatchObject({ sampleRate: 48000, normalizedId: imported.out.normalizedId });
  });

  it('accepts exactly 120 seconds and rejects 121 naming the limit', () => {
    const d = dir();
    const ok = cli(d, 'sample', 'overview', write(d, 'edge.wav', layout(120, [[1, sine(440, 0.5)]])), '--no-image');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.out.source.durationSec).toBe(120);
    const over = cli(d, 'sample', 'overview', write(d, 'over.wav', layout(121, [[1, sine(440, 0.5)]])), '--no-image');
    expect(over.status).not.toBe(0);
    expect(over.err.code).toBe('E_SCHEMA');
    expect(over.err.message).toMatch(/120/);
  });

  it('reports a corrupt project instead of treating the file as project-less', () => {
    const d = dir(); initProject(d);
    writeFileSync(join(d, '.agent-beeps', 'project.json'), '{');
    const r = cli(d, 'sample', 'overview', write(d, 'long.wav', long()));
    expect(r.err.code).toBe('E_PROJECT');
  });

  it('keeps 64 segments of 70 short bursts and says how to see the rest', () => {
    const d = dir();
    const bursts = layout(26, Array.from({ length: 70 }, (_, i): [number, Float32Array] => [0.1 + i * 0.36, sine(440, 0.06)]));
    const r = cli(d, 'sample', 'overview', write(d, 'bursts.wav', bursts), '--no-image');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.segments).toHaveLength(64);
    expect(r.out.omitted).toBeGreaterThan(0);
    expect(r.out.hints.join(' ')).toMatch(/--min-gap/);
  });

  it.skipIf(!hasChromium)('writes a PNG, in the project renders folder by default and at --out otherwise', () => {
    const d = dir(); initProject(d);
    const file = write(d, 'long.wav', long());
    const byDefault = cli(d, 'sample', 'overview', file);
    expect(byDefault.status, byDefault.stderr).toBe(0);
    // Match the tail, so a Windows 8.3 short temp path cannot make the prefix comparison fail.
    expect(byDefault.out.image.replaceAll('\\', '/')).toMatch(/\/\.agent-beeps\/renders\/overviews\/[0-9a-f]{12}\.png$/);
    const png = readFileSync(byDefault.out.image);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeGreaterThan(5000);
    const elsewhere = join(d, 'out', 'shape.png');
    const r = cli(d, 'sample', 'overview', file, '--out', elsewhere, '--start', '3', '--end', '9');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.image).toBe(elsewhere);
    expect(existsSync(elsewhere)).toBe(true);
    const outside = dir(); const loose = write(outside, 'long.wav', long());
    const loosely = cli(outside, 'sample', 'overview', loose, '--out', join(outside, 'o.png'));
    expect(loosely.status, loosely.stderr).toBe(0);
    expect(existsSync(join(outside, 'o.png'))).toBe(true);
  });
});
