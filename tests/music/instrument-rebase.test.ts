import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../../src/project.ts';
import { INSTRUMENTS_DIR, midiName } from '../../src/music.ts';
import { parseOrThrow, readJsonFile } from '../../src/project.ts';
import { rebaseInstrument } from '../../src/rebase.ts';
import { setPointer } from '../../src/pointer.ts';
import { parsePatch, type Patch } from '../../src/schema/patch.ts';
import { instrumentRoot } from '../../runtime/engine/song.js';
import { hzToMidi, noteToHz } from '../../runtime/engine/notes.js';

const library = (name: string) => parseOrThrow(readJsonFile(join(INSTRUMENTS_DIR, `${name}.json`)), name);
const apply = (patch: Patch, set: Record<string, unknown>): Patch => {
  const raw = structuredClone(patch) as unknown as Record<string, unknown>;
  for (const [ptr, value] of Object.entries(set)) setPointer(raw, ptr, value);
  const r = parsePatch(raw);
  if (!r.ok) throw new Error(r.issues[0].message);
  return r.patch;
};

describe('instrument rebase', () => {
  it('moves every pitched layer and scales their cutoffs by the same ratio', () => {
    const pluck = library('soft-pluck');
    const r = rebaseInstrument(pluck, 5);
    expect(r.root).toBe('C4');
    expect(r.rebuiltRoot).toBe('F4');
    expect(r.set['/layers/0/source/pitch']).toBe('F4');
    expect(r.set['/layers/1/source/pitch']).toBe('F5');
    const filter = pluck.layers[0].filter!;
    expect(r.set['/layers/0/filter/cutoff']).toBe(Math.round(filter.cutoff * 2 ** (5 / 12)));
    expect(r.filters).toBeGreaterThan(0);
  });

  it('builds a valid patch whose root is where it was asked to be', () => {
    const pad = library('warm-pad');
    const rebuilt = apply(pad, rebaseInstrument(pad, -12).set);
    expect(midiName(instrumentRoot(rebuilt as never)!)).toBe('C3');
    // Layer offsets are preserved: a layer an octave above the root is still an octave above it.
    pad.layers.forEach((layer, i) => {
      const a = (layer.source as { pitch?: string }).pitch, b = (rebuilt.layers[i].source as { pitch?: string }).pitch;
      if (a !== undefined) expect(hzToMidi(noteToHz(b!)) - hzToMidi(noteToHz(a))).toBe(-12);
    });
  });

  it('keeps the filters when asked, and leaves unpitched layers alone', () => {
    const piano = library('felt-piano');
    const kept = rebaseInstrument(piano, 7, { filters: 'keep' });
    expect(kept.filters).toBe(0);
    expect(Object.keys(kept.set).some(k => k.includes('/filter/'))).toBe(false);
    const followed = rebaseInstrument(piano, 7);
    // felt-piano's noise layer is the hammer thump: it is not tied to the note, so its filter stays put.
    const noise = piano.layers.findIndex(l => l.source.type === 'noise');
    expect(noise).toBeGreaterThanOrEqual(0);
    expect(Object.keys(followed.set).filter(k => k.startsWith(`/layers/${noise}/`))).toEqual([]);
  });

  it('moves note names and Hz pitches, and clamps a cutoff to the schema range', () => {
    const base = parsePatch({
      schema: 'beeps/patch@1', name: 'probe', family: 'foley', duration: 1,
      layers: [{
        source: { type: 'osc', wave: 'sine', pitch: 440 },
        pitchEnv: [{ at: 0.1, to: 880, curve: 'linear' }],
        filter: { type: 'lowpass', cutoff: 20000, resonanceDb: 0, env: { to: 30, time: 0.2 } },
        amp: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.1 },
      }],
    });
    if (!base.ok) throw new Error(base.issues[0].message);
    const up = rebaseInstrument(base.patch, 12);
    expect(up.set['/layers/0/source/pitch']).toBe(880);
    expect(up.set['/layers/0/pitchEnv/0/to']).toBe(1760);
    expect(up.set['/layers/0/filter/cutoff']).toBe(24000);
    const down = rebaseInstrument(base.patch, -24);
    expect(down.set['/layers/0/filter/env/to']).toBe(20);
  });

  it('refuses an unpitched instrument and a fractional shift', () => {
    expect(() => rebaseInstrument(library('hat'), 5)).toThrow(/no pitched layer/);
    expect(() => rebaseInstrument(library('warm-pad'), 1.5)).toThrow(/whole number/);
  });
});


describe('beeps instruments rebase', () => {
  const bin = join(import.meta.dirname, '..', '..', 'scripts/beeps.mjs');
  const cwd = initProject(mkdtempSync(join(tmpdir(), 'beeps-rebase-'))).paths.root;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [bin, 'instruments', ...args], { cwd, encoding: 'utf8', windowsHide: true });
    return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : undefined, err: r.stderr.trim() ? JSON.parse(r.stderr) : undefined };
  };

  it('prints a base-and-set override for a target root, and still lists the library without arguments', () => {
    const r = run('rebase', 'soft-pluck', '--to', 'F4');
    expect(r.status).toBe(0);
    expect(r.out.shiftSemitones).toBe(5);
    expect(r.out.override.base).toBe('soft-pluck');
    expect(r.out.override.set['/layers/0/source/pitch']).toBe('F4');
    expect(run().out.instruments.length).toBeGreaterThan(10);
  });

  it('wants exactly one of --by and --to, and names what it cannot rebase', () => {
    expect(run('rebase', 'soft-pluck').err.error.code).toBe('E_USAGE');
    expect(run('rebase', 'soft-pluck', '--by', '2', '--to', 'F4').err.error.code).toBe('E_USAGE');
    expect(run('rebase', 'hat', '--by', '5').err.error.message).toMatch(/no pitched layer/);
    expect(run('rebase', 'nope', '--by', '5').err.error.code).toBe('E_NOT_FOUND');
  });
});
