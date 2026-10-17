import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../src/audio/wav.ts';
import { SR, evenOnsets, shotTrain } from './helpers/signals.ts';

const bin = join(import.meta.dirname, '..', 'scripts', 'beeps.mjs');
const dir = mkdtempSync(join(tmpdir(), 'beeps-analyze-cli-'));

function beeps(...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
  const parse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  return { status: r.status, out: parse(r.stdout), err: parse(r.stderr)?.error };
}
const burst = (name: string, tau: number, interval = 0.087) => {
  writeFileSync(join(dir, name), writeWav([shotTrain(evenOnsets(16, interval), tau)], SR));
  return name;
};

describe('beeps analyze', () => {
  it('measures audio files that beeps did not render, with no project', () => {
    const r = beeps('analyze', burst('a.wav', 0.02), burst('b.wav', 0.01, 0.1));
    expect(r.status).toBe(0);
    expect(r.out.analyses).toHaveLength(2);
    expect(r.out.analyses[0]).toMatchObject({ file: 'a.wav', sampleRate: SR });
    expect(r.out.analyses[0].events.rpm).toBeCloseTo(690, -1);
    expect(r.out.analyses[1].events.rpm).toBeCloseTo(600, -1);
    expect(r.out.analyses[0].profile).toHaveLength(5);
  });

  it('fails with E_NOT_FOUND and the path when a file is missing', () => {
    const r = beeps('analyze', 'missing.wav');
    expect(r.status).toBe(1);
    expect(r.err).toMatchObject({ code: 'E_NOT_FOUND', message: expect.stringMatching(/missing\.wav/) });
  });
});

describe('beeps compare', () => {
  it('prints signed deltas and hints for a candidate against a reference', () => {
    const r = beeps('compare', burst('ref.wav', 0.04), burst('dry.wav', 0.004));
    expect(r.status).toBe(0);
    expect(r.out).toMatchObject({ reference: 'ref.wav', candidate: 'dry.wav' });
    expect(r.out.deltas.events.floorDb).toBeLessThan(-6);
    expect(r.out.hints.length).toBeGreaterThan(0);
    expect(r.out.summary.reference.rpm).toBeCloseTo(690, -1);
  });

  it('needs exactly a reference and a candidate', () => {
    const r = beeps('compare', 'ref.wav');
    expect(r.status).toBe(2);
    expect(r.err?.code).toBe('E_USAGE');
  });
});

describe('capabilities', () => {
  it('lists analyze and compare', () => {
    const r = beeps('capabilities', '--no-schema');
    const names = r.out.commands.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(['analyze', 'compare']));
  });
});
