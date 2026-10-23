// Honest feedback, Phase 3 (0.25.0): the small places a command told the caller less than it did.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pitchOf } from '../src/commands/shared.ts';
import { rebaseInstrument } from '../src/rebase.ts';
import { scanAlbums } from '../src/album.ts';
import { initProject } from '../src/project.ts';
import { readAgentCursor, readEventsChecked, sessionDir } from '../src/audition/session.ts';
import { countNonFinite, nonFiniteMessage } from '../src/audio/finite.ts';
import { parseCsv } from '../src/family.ts';
import { bundleDir } from '../src/bundle.ts';
import { unusedFieldNotices } from '../src/song-notices.ts';
import { staleVariantFiles } from '../src/export-assets.ts';
import { chromiumAvailable } from '../src/render/host.ts';
import { example } from './helpers/runtime-examples.ts';
import { song } from './helpers/songs.ts';
import { coin, patch } from './helpers/patches.ts';
import { add, beeps, project } from './helpers/cli.ts';

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `beeps-${name}-`));

describe('numbers that could be unknown say why', () => {
  it('gives a null pitch a reason', () => {
    expect(pitchOf({ pitchHz: 440, pitchStrength: 0.9 })).toEqual({ pitchHz: 440 });
    expect(pitchOf({ pitchHz: 0, pitchStrength: 0.2 })).toEqual({ pitchHz: null, pitchReason: 'no steady pitch (strength 0.2, needs 0.7)' });
  });

  it('refuses to describe a render with samples that are not numbers', () => {
    expect(countNonFinite([Float32Array.from([0, 1, NaN, Infinity, -Infinity]), Float32Array.from([0.5])])).toBe(3);
    expect(countNonFinite([new Float32Array(10)])).toBe(0);
    expect(nonFiniteMessage('patch', 1)).toMatch(/^patch rendered 1 sample that is not/);
    expect(nonFiniteMessage('song', 4)).toMatch(/4 samples that are not/);
  });
});

describe('instruments rebase', () => {
  it('counts the cutoffs it had to hold at the edge of the audible range', () => {
    const filtered = patch({ ...coin(), layers: [{ ...coin().layers[0], filter: { type: 'lowpass', cutoff: 6000, resonanceDb: 0 } }] });
    expect(rebaseInstrument(filtered, 12).clamped).toBe(0);
    expect(rebaseInstrument(filtered, 36).clamped).toBe(1);
    expect(rebaseInstrument(filtered, 36).set['/layers/0/filter/cutoff']).toBe(24000);
  });
});

describe('option values', () => {
  it('rejects a worker count or a pair count below 1 instead of using something else', () => {
    const dir = project();
    for (const args of [['song', 'render', 'x', '--jobs', '0'], ['song', 'stems', 'x', '--jobs', '-2'], ['song', 'compat', 'a', 'b', '--worst', '0'], ['build', '--jobs', '0']]) {
      const r = beeps(dir, ...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.err.code, args.join(' ')).toBe('E_USAGE');
      expect(r.err.message).toMatch(/1 or more/);
    }
  });
});

describe('what a listing leaves out', () => {
  it('names an album that could not be read, and why', () => {
    const p = initProject(tmp('albums'));
    mkdirSync(join(p.paths.albums, 'broken'), { recursive: true });
    writeFileSync(join(p.paths.albums, 'broken', 'album.json'), '{ not json');
    const scan = scanAlbums(p);
    expect(scan.albums).toEqual([]);
    expect(scan.unreadable).toHaveLength(1);
    expect(scan.unreadable[0].id).toBe('broken');
    const dir = project();
    mkdirSync(join(dir, '.agent-beeps', 'albums', 'broken'), { recursive: true });
    writeFileSync(join(dir, '.agent-beeps', 'albums', 'broken', 'album.json'), '{ not json');
    const r = beeps(dir, 'album', 'list');
    expect(r.out.albums).toEqual([]);
    expect(r.out.unreadable[0].id).toBe('broken');
  });

  it('lists a hidden directory of sidecars that a bundle did not search', () => {
    const dir = tmp('bundle');
    mkdirSync(join(dir, '.hidden'), { recursive: true });
    writeFileSync(join(dir, '.hidden', 'x.wav.json'), '{}');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'y.wav.json'), '{}');
    mkdirSync(join(dir, '.empty'), { recursive: true });
    const r = bundleDir(dir);
    expect(r.assets).toEqual([]);
    expect(r.skipped).toEqual(['.hidden/ (hidden directory, not searched)']);
    expect(bundleDir(tmp('bundle2')).skipped).toBeUndefined();
  });

  it('counts the lines of an audition log that could not be read', () => {
    const p = initProject(tmp('audition'));
    const dir = sessionDir(p, 's1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), ['{"type":"round","seq":1}', '{"type":"ref', '{"type":"ship","seq":2}', 'garbage'].join('\n') + '\n');
    const r = readEventsChecked(p, 's1');
    expect(r.events.map(e => e.type)).toEqual(['round', 'ship']);
    expect(r.malformed).toBe(2);
    expect(readEventsChecked(p, 'none')).toEqual({ events: [], malformed: 0 });
  });

  it('starts an unreadable agent cursor at the beginning and says so', () => {
    const dir = tmp('cursor');
    const file = join(dir, 'agent-cursor');
    expect(readAgentCursor(file)).toEqual({ cursor: 0, reset: false });
    writeFileSync(file, '7');
    expect(readAgentCursor(file)).toEqual({ cursor: 7, reset: false });
    writeFileSync(file, 'seven');
    expect(readAgentCursor(file)).toEqual({ cursor: 0, reset: true });
  });
});

describe('inputs that were read more loosely than they look', () => {
  it('says which CSV rows were short', () => {
    const warned: string[] = [];
    const rows = parseCsv('name,pitch,tail\na,C4,0.2\nb,D4\nc\n', m => warned.push(m));
    expect(rows).toHaveLength(3);
    expect(warned).toEqual(['CSV row 2 has 2 of 3 cells: tail read as empty', 'CSV row 3 has 1 of 3 cells: pitch, tail read as empty']);
    expect(parseCsv('name,pitch\na,C4\n', m => warned.push(m))).toHaveLength(1);
    expect(warned).toHaveLength(2);
  });

  it('reports pattern fields that do nothing where they are', () => {
    const s = song({ patterns: {
      'pad-a': { bars: 2, chords: { progression: 'a', octave: 4 }, hitBeats: 1, note: 'C4' },
      'hat-a': { bars: 1, steps: 'x.x.x.x.x.x.x.x.', hitBeats: 0.5 },
      lead: { bars: 1, notes: [[0, 'C4', 1], [1, 'D4', 1, 0.8], [2, 'E4', 1, 0.8, 0.5]] },
    }, sections: { a: { bars: 2, play: { pad: 'pad-a', hat: 'hat-a' } } } });
    const pointers = unusedFieldNotices(s).map(n => n.pointer);
    expect(pointers).toEqual(['/patterns/pad-a/hitBeats', '/patterns/pad-a/note', '/patterns/lead/notes/2']);
    expect(unusedFieldNotices(song())).toEqual([]);
  });

  it('finds variant files an earlier export left behind', () => {
    const dir = tmp('export');
    for (const f of ['coin.0.wav', 'coin.1.wav', 'coin.2.wav', 'coin.wav', 'coinage.0.wav', 'coin.3.wav.json']) writeFileSync(join(dir, f), '');
    const stale = staleVariantFiles(join(dir, 'coin.wav'), [join(dir, 'coin.0.wav'), join(dir, 'coin.1.wav')]);
    expect(stale.map(f => f.slice(dirname(f).length + 1))).toEqual(['coin.2.wav']);
    expect(staleVariantFiles(join(dir, 'coin.wav'), [])).toHaveLength(3);
    expect(staleVariantFiles(join(dir, 'missing', 'x.wav'), [])).toEqual([]);
  });
});

describe('taste outside a project', () => {
  it('says it read the global profile only', () => {
    process.env.AGENT_BEEPS_HOME = tmp('home');
    const outside = tmp('no-project');
    const r = beeps(outside, 'taste', 'show');
    expect(r.status).toBe(0);
    expect(r.out.scope).toBe('global only (no .agent-beeps project here)');
    expect(beeps(project(), 'taste', 'show').out.scope).toBe('project and global');
  });
});

const runtimePatch = () => example('comet-blaster');
const hasChromium = await chromiumAvailable();

describe.skipIf(!hasChromium)('rendering commands', () => {
  it('print the seed they drew when none was given', () => {
    const dir = project();
    const a = beeps(dir, 'generate', 'coin', '--count', '2');
    expect(Number.isInteger(a.out.seed)).toBe(true);
    expect(beeps(dir, 'generate', 'coin', '--count', '2', '--seed', '7').out.seed).toBe(7);
  });

  it('say a baked render used the defaults of a patch that has runtime inputs', () => {
    const dir = project();
    add(dir, runtimePatch());
    const n = beeps(dir, 'render', 'comet-blaster').out.renders[0].notices;
    expect(n.map((x: { code: string }) => x.code)).toContain('N_RUNTIME_AT_DEFAULTS');
    add(dir, coin());
    expect((beeps(dir, 'render', 'coin').out.renders[0].notices ?? []).map((x: { code: string }) => x.code)).not.toContain('N_RUNTIME_AT_DEFAULTS');
  });

  it('say a project patch file was left out of lint', () => {
    const dir = project();
    add(dir, coin());
    writeFileSync(join(dir, '.agent-beeps', 'patches', 'broken.json'), '{ "schema": "beeps/patch@1", "name": "broken" }');
    const notes = beeps(dir, 'lint', 'coin').out.notes as { rule: string; name?: string; message: string }[];
    const n = notes.find(x => x.rule === 'invalid-project-patch');
    expect(n?.name).toBe('broken.json');
    expect(n?.message).toMatch(/left it out/);
  });

  it('say that an export replaced a file and left old variant files beside it', () => {
    const dir = project();
    const flat = patch({ schema: 'beeps/patch@1', name: 'flat', family: 'test', duration: 0.3, variation: { variants: 3, gainDb: 3 }, layers: [{ source: { type: 'osc', wave: 'sine', pitch: 'C4' }, amp: { attack: 0.005, decay: 0.2, sustain: 0, release: 0.05 } }] });
    add(dir, flat);
    const wav = join(dir, 'out', 'flat.wav');
    const first = beeps(dir, 'export', 'flat', '--wav', wav, '--variants');
    expect(first.status).toBe(0);
    expect(first.out.replaced).toBeUndefined();
    expect(beeps(dir, 'export', 'flat', '--wav', wav, '--variants').out.replaced).toBe(true);
    const single = beeps(dir, 'export', 'flat', '--wav', wav);
    expect(single.out.replaced).toBeUndefined();
    expect(single.out.stale.map((f: string) => f.slice(-10))).toEqual(['flat.0.wav', 'flat.1.wav', 'flat.2.wav']);
    expect(single.out.warnings.join(' ')).toMatch(/earlier export/);
    expect(beeps(dir, 'export', 'flat', '--wav', wav).out.replaced).toBe(true);
  });
});

