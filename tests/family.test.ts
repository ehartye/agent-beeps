import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFamily, parseCsv } from '../src/family.ts';
import { BeepsError } from '../src/errors.ts';

const template = {
  schema: 'beeps/patch@1', name: 'step-{{surface}}', family: 'footstep', tags: ['repeating'], duration: 0.3,
  layers: [{
    source: { type: 'osc', wave: 'square', pitch: '{{pitch}}' },
    amp: { attack: 0.004, decay: 0.12, sustain: 0, release: 0.05 },
    filter: { type: 'lowpass', cutoff: '{{cutoff}}', resonanceDb: 0 },
  }],
};
const rows = [
  { surface: 'grass', pitch: 220, cutoff: 2000, tags: 'soft|outdoor' },
  { surface: 'stone', pitch: 'A4', cutoff: 5000, '/duration': 0.2 },
];

describe('buildFamily', () => {
  it('substitutes typed placeholders, pointers and tags', () => {
    const { patches } = buildFamily(template, rows);
    expect(patches.map(p => p.name)).toEqual(['step-grass', 'step-stone']);
    expect((patches[0].layers[0].source as any).pitch).toBe(220);
    expect(patches[0].layers[0].filter).toMatchObject({ cutoff: 2000 });
    expect(patches[0].tags).toEqual(['repeating', 'soft', 'outdoor']);
    expect(patches[1].duration).toBe(0.2);
  });

  it('is deterministic, and ranges and jitter depend on seed and row only', () => {
    const t = { ...template, layers: [{ ...template.layers[0], source: { type: 'osc', wave: 'square', pitch: '{{pitch}}' } }] };
    const r = [{ surface: 'a', pitch: '200..400', cutoff: 3000 }, { surface: 'b', pitch: 300, cutoff: 3000 }];
    const opts = { seed: 7, jitter: { '/layers/0/filter/cutoff': 0.1 } };
    const a = buildFamily(t, r, opts).patches;
    expect(buildFamily(t, r, opts).patches).toEqual(a);
    const pitchA = (a[0].layers[0].source as any).pitch;
    expect(pitchA).toBeGreaterThanOrEqual(200); expect(pitchA).toBeLessThanOrEqual(400);
    expect(a[1].layers[0].filter).not.toMatchObject({ cutoff: 3000 });
    expect(buildFamily(t, r, { ...opts, seed: 8 }).patches).not.toEqual(a);
    // dropping the other row does not move this row's draw
    expect(buildFamily(t, [r[0]], opts).patches[0]).toEqual(a[0]);
  });

  it('reports the row and a patch pointer for schema failures, collecting every row', () => {
    const bad = [{ surface: 'ok', pitch: 220, cutoff: 2000 }, { surface: 'bad', pitch: 220, cutoff: 2000, '/layers/0/amp/attack': -1 }, { surface: 'worse', pitch: 220, cutoff: 'high' }];
    try { buildFamily(template, bad); throw new Error('expected failure'); } catch (e) {
      expect(e).toBeInstanceOf(BeepsError);
      const err = e as BeepsError;
      expect(err.code).toBe('E_SCHEMA');
      expect(err.pointer).toMatch(/^\/layers\/0\//);
      expect((err.details.rows as any[]).map(r => r.row)).toEqual([1, 2]);
    }
  });

  it('points at the placeholder when a column is missing, and rejects duplicate names', () => {
    expect(() => buildFamily(template, [{ surface: 'x', pitch: 220 }])).toThrowError(/cutoff/);
    try { buildFamily(template, [{ surface: 'x', pitch: 220 }]); } catch (e) { expect((e as BeepsError).pointer).toBe('/layers/0/filter/cutoff'); }
    expect(() => buildFamily(template, [rows[0], rows[0]])).toThrowError(/more than one row/);
  });

  it('parses CSV with quoting and typed cells', () => {
    expect(parseCsv('surface,pitch,tags\r\ngrass,220,"soft|a,b"\nstone,A4,\n')).toEqual([
      { surface: 'grass', pitch: 220, tags: 'soft|a,b' }, { surface: 'stone', pitch: 'A4', tags: '' }]);
  });
});

describe('beeps family CLI', () => {
  const bin = join(import.meta.dirname, '..', 'scripts', 'beeps.mjs');
  const beeps = (cwd: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
    const parse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
    return { status: r.status, out: parse(r.stdout), err: parse(r.stderr)?.error };
  };

  it('dry-runs, writes to --out and the project, and refuses to overwrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-family-'));
    expect(beeps(dir, 'init').status).toBe(0);
    writeFileSync(join(dir, 't.json'), JSON.stringify(template));
    writeFileSync(join(dir, 'rows.csv'), 'surface,pitch,cutoff\ngrass,220,2000\nstone,330,5000\nleaf,440,1500\n');
    const dry = beeps(dir, 'family', 't.json', '--table', 'rows.csv', '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.out).toMatchObject({ dryRun: true, count: 3 });
    expect(existsSync(join(dir, '.agent-beeps', 'patches', 'step-grass.json'))).toBe(false);
    const run = beeps(dir, 'family', 't.json', '--table', 'rows.csv', '--out', 'audio');
    expect(run.status).toBe(0);
    expect(existsSync(join(dir, 'audio', 'step-leaf.json'))).toBe(true);
    expect(existsSync(join(dir, '.agent-beeps', 'patches', 'step-leaf.json'))).toBe(false);
    expect(beeps(dir, 'family', 't.json', '--table', 'rows.csv', '--out', 'audio').err.code).toBe('E_CONFLICT');
    expect(beeps(dir, 'family', 't.json', '--row', 'surface=mud,pitch=100,cutoff=900').status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, '.agent-beeps', 'patches', 'step-mud.json'), 'utf8')).name).toBe('step-mud');
    const bad = beeps(dir, 'family', 't.json', '--row', 'surface=z,pitch=1,cutoff=nope', '--dry-run');
    expect(bad.status).toBe(1);
    expect(bad.err).toMatchObject({ code: 'E_SCHEMA', pointer: expect.stringMatching(/^\/layers\/0\/filter/), rows: [expect.objectContaining({ row: 0 })] });
  });
});
