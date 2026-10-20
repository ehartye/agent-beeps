import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../../src/audio/wav.ts';
import { initProject } from '../../src/project.ts';
import { sampleId } from '../../src/samples/store.ts';
import { SR, sine } from '../helpers/signals.ts';

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
    for (const s of byId.out.segments) {
      const [, , , id, , start, , end] = s.prepare.split(' ');
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

  it('rejects bad arguments before doing work', () => {
    const d = dir(), file = write(d, 'long.wav', long());
    for (const args of [['--start', 'NaN'], ['--start', '13'], ['--end', '0'], ['--start', '5', '--end', '2'], ['--end', '13'], ['--gap-db', '0'], ['--gap-db', '101'], ['--min-gap', '5'], ['--min-gap', 'x']]) {
      const r = cli(d, 'sample', 'overview', file, '--no-image', ...args);
      expect(r.status, JSON.stringify(args)).not.toBe(0);
      expect(r.err.code, JSON.stringify(args)).toBe('E_SCHEMA');
    }
    expect(cli(d, 'sample', 'overview', 'sha256:abc', '--no-image').err.code).toBe('E_SCHEMA');
    expect(cli(d, 'sample', 'overview', join(d, 'missing.wav'), '--no-image').err.code).toBe('E_NOT_FOUND');
    expect(cli(d, 'sample', 'overview', file).err.code).toBe('E_USAGE'); // image wanted, no project, no --out
  });

  it('needs a project for an ID and refuses an unknown one', () => {
    const d = dir(), id = `sha256:${'0'.repeat(64)}`;
    expect(cli(d, 'sample', 'overview', id, '--no-image').err.code).toBe('E_PROJECT');
    initProject(d);
    expect(cli(d, 'sample', 'overview', id, '--no-image').err.code).toBe('E_NOT_FOUND');
  });

  it('rejects a source over 120 seconds', () => {
    const d = dir(), file = write(d, 'huge.wav', layout(121, [[1, sine(440, 0.5)]]));
    const r = cli(d, 'sample', 'overview', file, '--no-image');
    expect(r.status).not.toBe(0);
    expect(r.err.code).toBe('E_SCHEMA');
  });
});
