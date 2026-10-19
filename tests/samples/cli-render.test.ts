import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumAvailable } from '../../src/render/host.ts';
import { initProject, savePatch } from '../../src/project.ts';
import { samplePaths, writeSampleObject } from '../../src/samples/store.ts';
import { sampleFixture } from '../helpers/samples.ts';

const bin = join(import.meta.dirname, '../../scripts/beeps.mjs');
const cli = (cwd: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout ? JSON.parse(r.stdout) : undefined };
};
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-sample-cli-')), p = initProject(dir), f = sampleFixture({ live: true });
  f.patch.layers[0].amp.attack = 0.005;
  savePatch(p, f.patch); writeSampleObject(samplePaths(p).objects, f.wav);
  return { dir, p, f };
};

describe.skipIf(!(await chromiumAvailable()))('project sample rendering commands', () => {
  it('uses the explicit nearest project store for normal render, measure and baked export', () => {
    const { dir, f } = setup();
    const render = cli(dir, 'render', f.patch.name);
    expect(render.status, render.stderr).toBe(0);
    expect(render.out.renders[0].ok).not.toBe(false);
    const measured = cli(dir, 'measure', f.patch.name);
    expect(measured.status, measured.stderr).toBe(0);
    expect(Number.isFinite(measured.out.features.momentaryMaxLufs)).toBe(true);
    const exported = cli(dir, 'export', f.patch.name, '--wav', join(dir, 'out.wav'));
    expect(exported.status, exported.stderr).toBe(0);
    expect(existsSync(join(dir, 'out.wav'))).toBe(true);
  }, 120000);
  it('preloads the fixed-trim runtime check and keeps --project-file limited to settings', () => {
    const { dir, f, p } = setup(), settings = join(dir, 'settings.json');
    writeFileSync(settings, JSON.stringify(p.project));
    const checked = cli(dir, 'runtime', 'check', f.patch.name, '--project-file', settings);
    expect(checked.status, checked.stderr).toBe(0);
    const corners = checked.out.reports[0].corners;
    expect(corners.every((c: any) => c.runtime && !c.error)).toBe(true);
    expect(corners.find((c: any) => c.corner === 'level=max').runtime.vsDefaultLu).toBeCloseTo(-12, 1);
  }, 120000);
  it('passes verified bytes to runtime parity, perf, look and live commands', () => {
    const { dir, f } = setup();
    const parity = cli(dir, 'runtime', 'parity', f.patch.name, '--runs', '1');
    expect(parity.status, parity.stderr).toBe(0);
    expect(parity.out.reports[0].cases.every((c: any) => c.controlKind === 'sample-content' && c.hostEqualsHarness)).toBe(true);
    const perf = cli(dir, 'runtime', 'perf', f.patch.name, '--n', '3');
    expect(perf.status, perf.stderr).toBe(0);
    expect(perf.out.perf[0].warmCounts.buffers).toBe(0);
    const look = cli(dir, 'runtime', 'look', f.patch.name, '--out', join(dir, 'looks'));
    expect(look.status, look.stderr).toBe(0);
    expect(look.out.diff.bitExact).toBe(true);
    const live = cli(dir, 'runtime', 'live', f.patch.name, '--input', 'level', '--to', '1', '--at', '0.3', '--tau', '0.01');
    expect(live.status, live.stderr).toBe(0);
    expect(live.out.live.finite).toBe(true);
  }, 180000);
});
