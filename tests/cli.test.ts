import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumAvailable } from '../src/render/host.ts';
import { coin } from './helpers/patches.ts';

const bin = join(import.meta.dirname, '..', 'scripts', 'beeps.mjs');
const hasChromium = await chromiumAvailable();

function beeps(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  const parse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  return { status: r.status, out: parse(r.stdout), err: parse(r.stderr)?.error, stdout: r.stdout, stderr: r.stderr };
}

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-cli-'));
  expect(beeps(dir, 'init').status).toBe(0);
  return dir;
};

describe('beeps CLI', () => {
  it('inits a project layout', () => {
    const dir = project();
    for (const p of ['project.json', 'kit.json', 'patches', 'sets', 'sessions', 'taste', 'renders', '.gitignore']) {
      expect(existsSync(join(dir, '.agent-beeps', p)), p).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(dir, '.agent-beeps', 'project.json'), 'utf8')).targetLoudness).toBe(-18);
  });

  it('prints capabilities with schema, source types and error codes', () => {
    const r = beeps(tmpdir(), 'capabilities');
    expect(r.status).toBe(0);
    expect(r.out.sourceTypes).toContain('modal');
    expect(r.out.errorCodes).toContain('E_SCHEMA');
    expect(r.out.patchSchema).toHaveProperty('$schema');
    expect(r.out.commands.map((c: { name: string }) => c.name)).toContain('render');
  });

  it('rejects q on a lowpass with a pointer and hint on stderr and exit 1', () => {
    const dir = project();
    const bad: any = coin();
    bad.layers[0].filter = { type: 'lowpass', cutoff: 2000, q: 4 };
    writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad));
    const r = beeps(dir, 'new', 'bad.json');
    expect(r.status).toBe(1);
    expect(r.err).toMatchObject({ code: 'E_SCHEMA', pointer: '/layers/0/filter', hint: expect.stringMatching(/resonanceDb/) });
  });

  it('saves patches and refuses to overwrite without --force', () => {
    const dir = project();
    writeFileSync(join(dir, 'coin.json'), JSON.stringify(coin()));
    expect(beeps(dir, 'new', 'coin.json').status).toBe(0);
    expect(beeps(dir, 'new', 'coin.json').err.code).toBe('E_CONFLICT');
    expect(beeps(dir, 'new', 'coin.json', '--force').status).toBe(0);
    expect(beeps(dir, 'list').out.patches[0].name).toBe('coin');
  });

  it('sync imports a directory of patches, updates changed ones, and leaves unchanged ones alone', () => {
    const dir = project();
    const src = join(dir, 'patches');
    mkdirSync(src);
    writeFileSync(join(src, 'coin.json'), JSON.stringify(coin()));
    writeFileSync(join(src, 'coin-2.json'), JSON.stringify({ ...coin(), name: 'coin-2' }));
    writeFileSync(join(src, 'notes.txt'), 'not a patch');
    const first = beeps(dir, 'sync', 'patches');
    expect(first.status, first.stderr).toBe(0);
    expect(first.out).toMatchObject({ added: ['coin', 'coin-2'], updated: [], unchanged: [] });
    expect(beeps(dir, 'list').out.patches.map((x: { name: string }) => x.name).sort()).toEqual(['coin', 'coin-2']);
    writeFileSync(join(src, 'coin.json'), JSON.stringify({ ...coin(), duration: 0.25 }));
    const second = beeps(dir, 'sync', 'patches');
    expect(second.out).toMatchObject({ added: [], updated: ['coin'], unchanged: ['coin-2'] });
    expect(JSON.parse(readFileSync(join(dir, '.agent-beeps', 'patches', 'coin.json'), 'utf8')).duration).toBe(0.25);
    // `new` still refuses to overwrite; sync is the way to mirror a committed directory.
    expect(beeps(dir, 'new', join('patches', 'coin.json')).err.code).toBe('E_CONFLICT');
  });

  it('sync validates every file before writing any, and refuses two files with one patch name', () => {
    const dir = project();
    const src = join(dir, 'patches');
    mkdirSync(src);
    writeFileSync(join(src, 'a.json'), JSON.stringify(coin()));
    const bad: any = { ...coin(), name: 'bad' };
    bad.layers[0].amp.attack = -1;
    writeFileSync(join(src, 'b.json'), JSON.stringify(bad));
    const r = beeps(dir, 'sync', 'patches');
    expect(r.status).toBe(1);
    expect(r.err).toMatchObject({ code: 'E_SCHEMA', pointer: '/layers/0/amp/attack' });
    expect(r.err.message).toMatch(/b\.json/);
    expect(beeps(dir, 'list').out.patches).toHaveLength(0);
    writeFileSync(join(src, 'b.json'), JSON.stringify(coin()));
    expect(beeps(dir, 'sync', 'patches').err.code).toBe('E_CONFLICT');
    expect(beeps(dir, 'sync', 'missing-dir').err.code).toBe('E_NOT_FOUND');
    writeFileSync(join(src, 'b.json'), JSON.stringify({ ...coin(), name: 'coin-b' }));
    const dry = beeps(dir, 'sync', 'patches', '--dry-run');
    expect(dry.out).toMatchObject({ dryRun: true, added: ['coin', 'coin-b'] });
    expect(beeps(dir, 'list').out.patches).toHaveLength(0);
  });

  it.skipIf(!hasChromium)('lint accepts a repeating patch whose variants are sibling patches', () => {
    const dir = project();
    const src = join(dir, 'patches');
    mkdirSync(src);
    for (const n of [0, 1, 2]) writeFileSync(join(src, `coin-${n}.json`), JSON.stringify({ ...coin(), name: `coin-${n}`, tags: ['repeating'], duration: 0.2 + n * 0.02 }));
    writeFileSync(join(dir, 'lone.json'), JSON.stringify({ ...coin(), name: 'lone', tags: ['repeating'] }));
    // Siblings linted together, siblings found in the project, and a lone repeating patch that still needs variation.
    const together = beeps(dir, 'lint', ...[0, 1, 2].map(n => join('patches', `coin-${n}.json`)), 'lone.json');
    const rules = (name: string) => together.out.reports.find((r: { name: string }) => r.name === name).errors.map((e: { rule: string }) => e.rule);
    expect(rules('coin-0')).not.toContain('variation-on-repeating');
    expect(rules('lone')).toContain('variation-on-repeating');
    expect(beeps(dir, 'sync', 'patches').status).toBe(0);
    const alone = beeps(dir, 'lint', 'coin-1');
    expect(alone.out.reports[0].errors.map((e: { rule: string }) => e.rule)).not.toContain('variation-on-repeating');
  });

  it('dry-runs a batch and reports the failing operationIndex without writing', () => {
    const dir = project();
    const ops = [
      { op: 'create', patch: coin() },
      { op: 'set', name: 'coin', pointer: '/layers/0/amp/attack', value: -1 },
    ];
    writeFileSync(join(dir, 'ops.json'), JSON.stringify(ops));
    const r = beeps(dir, 'batch', 'ops.json', '--dry-run');
    expect(r.status).toBe(1);
    expect(r.err).toMatchObject({ code: 'E_SCHEMA', operationIndex: 1, pointer: '/layers/0/amp/attack' });
    expect(beeps(dir, 'list').out.patches).toHaveLength(0);
    writeFileSync(join(dir, 'ops.json'), JSON.stringify([ops[0], { ...ops[1], value: 0.01 }]));
    expect(beeps(dir, 'batch', 'ops.json').out).toMatchObject({ applied: 2, changed: ['coin'] });
  });

  it('fails with E_PROJECT outside a project and E_USAGE for unknown commands', () => {
    const empty = mkdtempSync(join(tmpdir(), 'beeps-none-'));
    expect(beeps(empty, 'list').err.code).toBe('E_PROJECT');
    const r = beeps(empty, 'frobnicate');
    expect(r.status).toBe(2);
    expect(r.err.code).toBe('E_USAGE');
  });

  it.skipIf(!hasChromium)('renders, looks and exports a patch', () => {
    const dir = project();
    writeFileSync(join(dir, 'coin.json'), JSON.stringify({ ...coin(), variation: { pitchCents: 30, variants: 3 } }));
    beeps(dir, 'new', 'coin.json');
    const r = beeps(dir, 'render', 'coin', '--variants');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.renders).toHaveLength(3);
    expect(r.out.renders[0].features.loudnessLufs).toBeCloseTo(-19, 0);
    const look = beeps(dir, 'look', 'coin');
    expect(existsSync(look.out.look)).toBe(true);
    const ex = beeps(dir, 'export', 'coin', '--wav', 'out/coin.wav');
    expect(ex.status, ex.stderr).toBe(0);
    expect(readFileSync(join(dir, 'out', 'coin.wav')).subarray(0, 4).toString()).toBe('RIFF');
  });

  it.skipIf(!hasChromium)('lint --brief lists only patches with findings, names the clean ones and states each judgement rule once', () => {
    const dir = project();
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ ...coin(), name: 'coin-a' }));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ ...coin(), name: 'coin-b', layers: [{ ...coin().layers[0], amp: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.05 } }] }));
    const full = beeps(dir, 'lint', 'a.json', 'b.json');
    const brief = beeps(dir, 'lint', 'a.json', 'b.json', '--brief');
    expect(brief.out.reports.map((r: { name: string }) => r.name)).toEqual(full.out.reports.filter((r: { errors: unknown[]; warnings: unknown[] }) => r.errors.length || r.warnings.length).map((r: { name: string }) => r.name));
    expect(brief.out.reports.every((r: Record<string, unknown>) => !('judgement' in r))).toBe(true);
    expect([...brief.out.clean, ...brief.out.reports.map((r: { name: string }) => r.name)].sort()).toEqual(['coin-a', 'coin-b']);
    expect(new Set(brief.out.judgement.map((j: { rule: string }) => j.rule)).size).toBe(brief.out.judgement.length);
    expect(brief.status).toBe(full.status);
  });

  it.skipIf(!hasChromium)('set create turns authored patches into an auditionable set', () => {
    const dir = project();
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ ...coin(), name: 'coin-a' }));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ ...coin(), name: 'coin-b' }));
    const r = beeps(dir, 'set', 'create', 'a.json', 'b.json', '--prompt', 'two coins');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.candidates.map((c: { name: string }) => c.name)).toEqual(['coin-a', 'coin-b']);
    expect(existsSync(r.out.sheet)).toBe(true);
    const dup = beeps(dir, 'set', 'create', 'a.json', 'a.json');
    expect(dup.status).toBe(1);
    expect(dup.err.code).toBe('E_USAGE');
    const open = beeps(dir, 'audition', 'open', '--set', r.out.set, '--flow', 'explore');
    expect(open.status, open.stderr).toBe(0);
    expect(open.out.url).toMatch(/\/s\//);
    beeps(dir, 'audition', 'close', '--id', open.out.id);
  });
});
