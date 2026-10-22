// Phase 1 of the honest-feedback spec, end to end: each of these used to leave the agent believing something false.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumAvailable } from '../src/render/host.ts';
import { coin, patch } from './helpers/patches.ts';

const bin = join(import.meta.dirname, '..', 'scripts', 'beeps.mjs');
const hasChromium = await chromiumAvailable();

function beeps(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  const parse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  return { status: r.status, out: parse(r.stdout), err: parse(r.stderr)?.error };
}

const layer = (source: Record<string, unknown>) => ({ source, amp: { attack: 0.005, decay: 0.2, sustain: 0, release: 0.05 } });
const sine466 = patch({ schema: 'beeps/patch@1', name: 'off-key', family: 'test', duration: 0.3, layers: [layer({ type: 'osc', wave: 'sine', pitch: 466 })] });
const silent = patch({ ...coin(), name: 'silent', layers: [{ ...coin().layers[0], gainDb: -60, filter: { type: 'lowpass', cutoff: 5, resonanceDb: 0 } }] });
const flat = patch({ schema: 'beeps/patch@1', name: 'flat', family: 'test', duration: 0.3, variation: { variants: 3 }, layers: [layer({ type: 'osc', wave: 'sine', pitch: 'C4' })] });

function project(scale?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-honest-'));
  expect(beeps(dir, 'init', ...(scale ? ['--scale', scale] : [])).status).toBe(0);
  return dir;
}
function add(dir: string, ...patches: object[]) {
  for (const p of patches) {
    const file = join(dir, `${(p as { name: string }).name}.src.json`);
    writeFileSync(file, JSON.stringify(p));
    expect(beeps(dir, 'new', file, '--force').status).toBe(0);
  }
}

describe.skipIf(!hasChromium)('scale snap is reported', () => {
  it('render, measure and look say which pitch the scale moved', () => {
    const dir = project();
    add(dir, sine466);
    const render = beeps(dir, 'render', 'off-key');
    const n = render.out.renders[0].notices[0];
    expect(n).toMatchObject({ code: 'N_SCALE_SNAP', severity: 'warn', pointer: '/layers/0/source/pitch', requested: 466 });
    expect(beeps(dir, 'measure', 'off-key').out.notices[0].code).toBe('N_SCALE_SNAP');
    expect(beeps(dir, 'look', 'off-key').out.notices[0].code).toBe('N_SCALE_SNAP');
  });

  it('lint and export carry it too', () => {
    const dir = project();
    add(dir, sine466);
    expect(beeps(dir, 'lint', 'off-key').out.reports[0].notices[0].code).toBe('N_SCALE_SNAP');
    expect(beeps(dir, 'export', 'off-key', '--wav', join(dir, 'o.wav')).out.notices[0].code).toBe('N_SCALE_SNAP');
  });

  it('is silent in a scale that does not move the pitch', () => {
    const dir = project('A#:chromatic');
    add(dir, sine466);
    expect(beeps(dir, 'render', 'off-key').out.renders[0].notices).toBeUndefined();
  });

  it('keeps a patch with only a notice out of the brief lint "clean" list', () => {
    const dir = project();
    add(dir, sine466);
    const r = beeps(dir, 'lint', 'off-key', '--brief').out;
    expect(r.clean).not.toContain('off-key');
    expect(r.reports.map((x: { name: string }) => x.name)).toContain('off-key');
  });
});

describe.skipIf(!hasChromium)('crossover', () => {
  it('rejects a --t that is not a number from 0 to 1', () => {
    const dir = project();
    add(dir, coin());
    for (const t of ['abc', '2', '-0.1']) {
      const r = beeps(dir, 'crossover', 'coin', 'coin', '--name', 'child', '--t', t);
      expect(r.status, t).toBe(1);
      expect(r.err.code).toBe('E_USAGE');
    }
  });

  it('refuses to overwrite a patch without --force, and reports the parents and t', () => {
    const dir = project();
    add(dir, coin(), { ...coin(), name: 'coin-2', layers: [{ ...coin().layers[0], amp: { ...coin().layers[0].amp, decay: 0.3 } }] });
    const first = beeps(dir, 'crossover', 'coin', 'coin-2', '--name', 'child', '--t', '0.25');
    expect(first.status).toBe(0);
    expect(first.out).toMatchObject({ name: 'child', parents: ['coin', 'coin-2'], t: 0.25 });
    const again = beeps(dir, 'crossover', 'coin', 'coin-2', '--name', 'child');
    expect(again.err.code).toBe('E_CONFLICT');
    expect(beeps(dir, 'crossover', 'coin', 'coin-2', '--name', 'child', '--force').status).toBe(0);
  });
});

describe.skipIf(!hasChromium)('kit check', () => {
  it('lists a sound that failed to render as a failure and exits 1', () => {
    const dir = project();
    add(dir, coin(), silent);
    expect(beeps(dir, 'kit', 'add', 'coin').status).toBe(0);
    // A patch that renders when added and fails later (here: edited to silence) must not vanish from the check.
    const kit = join(dir, '.agent-beeps', 'kit.json');
    const k = JSON.parse(readFileSync(kit, 'utf8'));
    k.sounds.push({ name: 'silent', family: 'coin', priority: 3 });
    writeFileSync(kit, JSON.stringify(k));
    const r = beeps(dir, 'kit', 'check');
    expect(r.status).toBe(1);
    expect(r.out.sounds.map((s: { name: string }) => s.name)).toEqual(['coin', 'silent']);
    expect(r.out.sounds[1]).toMatchObject({ name: 'silent', ok: false });
    expect(r.out.sounds[1].error).toMatch(/./);
  });

  it('exits 0 when every sound renders', () => {
    const dir = project();
    add(dir, coin());
    beeps(dir, 'kit', 'add', 'coin');
    const r = beeps(dir, 'kit', 'check');
    expect(r.status).toBe(0);
    expect(r.out.sounds.every((s: { ok?: boolean }) => s.ok !== false)).toBe(true);
  });
});

describe.skipIf(!hasChromium)('variants', () => {
  it('warns when declared variants cannot differ', () => {
    const dir = project();
    add(dir, flat);
    const r = beeps(dir, 'render', 'flat', '--variants').out;
    expect(r.renders).toHaveLength(3);
    expect(r.notices.map((n: { code: string }) => n.code)).toEqual(['N_VARIANTS_IDENTICAL']);
    expect(beeps(dir, 'lint', 'flat').out.reports[0].notices.map((n: { code: string }) => n.code)).toContain('N_VARIANTS_IDENTICAL');
  });

  it('says when variants were asked for and the patch declares none', () => {
    const dir = project();
    add(dir, coin());
    const r = beeps(dir, 'render', 'coin', '--variants').out;
    expect(r.renders).toHaveLength(1);
    expect(r.notices[0].code).toBe('N_NO_VARIANTS');
  });

  it('rejects a --variant the patch does not declare', () => {
    const dir = project();
    add(dir, flat);
    for (const cmd of [['measure', 'flat', '--variant', '5'], ['export', 'flat', '--wav', join(dir, 'x.wav'), '--variant', '3']]) {
      const r = beeps(dir, ...cmd);
      expect(r.err.code).toBe('E_USAGE');
      expect(r.err.message).toMatch(/declares 3 variants/);
    }
    expect(beeps(dir, 'measure', 'flat', '--variant', '2').status).toBe(0);
  });
});
