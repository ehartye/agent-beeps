// Honest feedback, Phase 2b (0.21.0): the state behind a result is reported. A trim held at its limit, an input value clamped
// to its range, a kit entry that was replaced, a seed that differs between commands, and a project name hiding a library one.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseTrim } from '../src/render/cache.ts';
import { stateTrim } from '../src/render/layers.ts';
import { trimNotices } from '../src/patch-notices.ts';
import { parseInputPairs, resolveInputs } from '../src/runtime/inputs.ts';
import { initProject, savePatch } from '../src/project.ts';
import { listSongs, shadowedInstruments, INSTRUMENTS_DIR } from '../src/music.ts';
import { chromiumAvailable } from '../src/render/host.ts';
import { coin } from './helpers/patches.ts';
import { example } from './helpers/runtime-examples.ts';
import { HAT, PAD, song } from './helpers/songs.ts';
import { add, beeps, project } from './helpers/cli.ts';

describe('the loudness trim says when it was held at its limit', () => {
  it('reports nothing inside the range', () => {
    expect(chooseTrim(-6.123, 4)).toEqual({ trimDb: -6.12 });
  });

  it('reports the requested and the applied trim when the range set it', () => {
    expect(chooseTrim(-52.4, -10)).toEqual({ trimDb: -36, clamped: { requestedDb: -52.4, appliedDb: -36 } });
    expect(chooseTrim(40, 30.4)).toEqual({ trimDb: 24, clamped: { requestedDb: 30.4, appliedDb: 24 } });
  });

  it('holds the true-peak ceiling first, and only then the range', () => {
    expect(chooseTrim(10, -2)).toEqual({ trimDb: -2 });
  });

  it('turns it into a notice that names the direction', () => {
    const features = (c: { requestedDb: number; appliedDb: number } | undefined) => ({ delivered: { trimClamped: c } }) as never;
    expect(trimNotices('boom', features(undefined))).toEqual([]);
    const [loud] = trimNotices('boom', features({ requestedDb: -52.4, appliedDb: -36 }));
    expect(loud).toMatchObject({ code: 'N_TRIM_CLAMPED', severity: 'warn', requested: -52.4, applied: -36 });
    expect(loud.message).toMatch(/louder than the target by 16\.4 dB/);
    expect(trimNotices('hum', features({ requestedDb: 31, appliedDb: 24 }))[0].message).toMatch(/quieter than the target by 7 dB/);
  });

  it('also reports a state trim held at plus or minus 12 dB', () => {
    const sine = (amp: number) => [Float32Array.from({ length: 48000 }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / 48000))];
    const quiet = stateTrim(sine(0.001), 48000, -20);
    expect(quiet.trimDb).toBe(12);
    expect(quiet.clamped).toMatchObject({ appliedDb: 12 });
    expect(quiet.clamped!.requestedDb).toBeGreaterThan(12);
    expect(stateTrim(sine(0.1), 48000, -20).clamped).toBeUndefined();
  });
});

describe('runtime input values', () => {
  const rt = () => example('comet-blaster');
  const input = () => Object.entries(rt().xRuntime!.inputs)[0];

  it('parses name=value pairs and refuses anything that is not a number', () => {
    expect(parseInputPairs(['size=1', 'distance=0.4'])).toEqual({ size: 1, distance: 0.4 });
    for (const bad of ['size', 'size=', 'size=abc', '=3']) expect(() => parseInputPairs([bad]), bad).toThrow(/not an input value/);
  });

  it('uses a value inside the range as given and clamps one outside it, with a notice', () => {
    const [name, d] = input();
    const inside = resolveInputs(rt(), { [name]: (d.min + d.max) / 2 });
    expect(inside.notices).toEqual([]);
    const above = resolveInputs(rt(), { [name]: d.max + 5 });
    expect(above.params[name]).toBe(d.max);
    expect(above.notices[0]).toMatchObject({ code: 'N_INPUT_CLAMPED', pointer: `/xRuntime/inputs/${name}`, requested: d.max + 5, applied: d.max });
  });

  it('rejects an input the patch does not declare, naming the ones it does', () => {
    let thrown: unknown;
    try { resolveInputs(rt(), { nope: 1 }); } catch (e) { thrown = e; }
    expect(thrown).toMatchObject({ code: 'E_USAGE' });
    expect((thrown as Error & { hint: string }).hint).toContain(input()[0]);
    expect(() => resolveInputs(coin(), { size: 1 })).toThrow(/declares no input/);
  });
});

describe('a project name hiding a library one', () => {
  const lib = readdirSync(INSTRUMENTS_DIR).find(f => f.endsWith('.json'))!.slice(0, -5);

  it('is reported for an instrument a song names', () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-shadow-')));
    const own = song({ tracks: { pad: { instrument: lib }, hat: { instrument: HAT } } });
    expect(shadowedInstruments(p, own)).toEqual([]);
    savePatch(p, { ...coin(), name: lib, family: 'music' });
    expect(shadowedInstruments(p, own)).toEqual([lib]);
    // The song's own instruments win over both, so they hide nothing.
    expect(shadowedInstruments(p, song({ instruments: { [lib]: PAD }, tracks: { pad: { instrument: lib }, hat: { instrument: HAT } } }))).toEqual([]);
  });

  it('marks a project song that hides a library song', () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-shadow-')));
    const libSong = listSongs(p).find(s => s.source.startsWith('library/'))!;
    expect(libSong.shadows).toBeUndefined();
    writeFileSync(join(p.paths.songs, `${libSong.name}.json`), JSON.stringify(song({ name: libSong.name })));
    const shadowing = listSongs(p).find(s => s.name === libSong.name)!;
    expect(shadowing).toMatchObject({ source: 'project', shadows: libSong.source });
    expect(listSongs(p).filter(s => s.name === libSong.name)).toHaveLength(1);
  });

  it('shows up in the song and instrument listings', () => {
    const dir = project();
    expect(beeps(dir, 'instruments').out.notices).toBeUndefined();
    add(dir, { ...coin(), name: lib, family: 'music' });
    const r = beeps(dir, 'instruments').out;
    expect(r.instruments.find((i: { name: string }) => i.name === lib)).toMatchObject({ shadowedBy: 'project patch' });
    expect(r.notices.map((n: { code: string }) => n.code)).toEqual(['N_NAME_SHADOWED']);
  });
});

describe('runtime look checks its inputs before it renders', () => {
  it('fails a value that is not a number, and an input the patch does not declare, without a browser', () => {
    const dir = project();
    add(dir, example('comet-blaster'));
    for (const set of ['x=abc', 'nope=1']) {
      const r = beeps(dir, 'runtime', 'look', 'comet-blaster', '--set', set, '--out', join(dir, 'o'));
      expect(r.status, set).toBe(1);
      expect(r.err.code, set).toBe('E_USAGE');
    }
  });
});

describe.skipIf(!(await chromiumAvailable()))('kit seeds and replacement', () => {
  const setKit = (dir: string, edit: (k: { sounds: Record<string, unknown>[] }) => void) => {
    const file = join(dir, '.agent-beeps', 'kit.json');
    const k = JSON.parse(readFileSync(file, 'utf8'));
    edit(k);
    writeFileSync(file, JSON.stringify(k));
  };

  it('renders, measures, looks at and checks a kit sound at the seed it ships with', () => {
    const dir = project();
    add(dir, coin());
    expect(beeps(dir, 'kit', 'add', 'coin').status).toBe(0);
    setKit(dir, k => { k.sounds[0].seed = 7; });
    expect(beeps(dir, 'render', 'coin').out.renders[0].seed).toBe(7);
    expect(beeps(dir, 'render', 'coin', '--seed', '3').out.renders[0].seed).toBe(3);
    expect(beeps(dir, 'look', 'coin').out.seed).toBe(7);
    expect(beeps(dir, 'kit', 'check').out.sounds[0].seed).toBe(7);
  });

  it('keeps the audition seed when a sound is added again, and says what the replaced entry was', () => {
    const dir = project();
    add(dir, coin());
    beeps(dir, 'kit', 'add', 'coin', '--priority', '2');
    setKit(dir, k => { k.sounds[0].seed = 7; });
    const again = beeps(dir, 'kit', 'add', 'coin');
    expect(again.status).toBe(0);
    expect(again.out.sounds[0]).toMatchObject({ name: 'coin', seed: 7, priority: 3 });
    expect(again.out.replaced).toMatchObject({ name: 'coin', seed: 7, priority: 2 });
    expect(again.out.notices[0]).toMatchObject({ code: 'N_KIT_REPLACED', severity: 'warn' });
    expect(again.out.notices[0].message).toMatch(/priority 2 -> 3/);
    expect(again.out.notices[0].message).toMatch(/seed 7 was kept/);
  });

  it('is quiet when nothing it carried changes', () => {
    const dir = project();
    add(dir, coin());
    beeps(dir, 'kit', 'add', 'coin');
    const again = beeps(dir, 'kit', 'add', 'coin');
    expect(again.out.replaced).toBeDefined();
    expect(again.out.notices).toBeUndefined();
  });
});
