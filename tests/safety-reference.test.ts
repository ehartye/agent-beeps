// 0.27.0: output paths that overwrite the wrong thing, the generated reference, the worked examples, and the song notices computed from the document.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseCollision, isInside, requireDistinctDirs, requireSafeOutput, sameFile } from '../src/path-safety.ts';
import { ARCHETYPES_DIR, loadArchetypes } from '../src/archetypes.ts';
import { buildProgram } from '../src/cli.ts';
import { leafCommands } from '../src/commands/inventory.ts';
import { registerNotices } from '../src/song-notices.ts';
import { NOTICE_CODES } from '../src/notices.ts';
import { coin, patch } from './helpers/patches.ts';
import { PAD, song } from './helpers/songs.ts';
import { add, beeps, project } from './helpers/cli.ts';

const root = join(import.meta.dirname, '..');
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `beeps-${name}-`));
const thrown = (fn: () => unknown) => { try { fn(); } catch (e) { return e as Error & { code?: string; hint?: string }; } throw new Error('expected an error'); };

describe('path safety', () => {
  it('knows a folder from the paths inside it', () => {
    const dir = tmp('inside');
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    expect(isInside(join(dir, 'a', 'b'), join(dir, 'a'))).toBe(true);
    expect(isInside(join(dir, 'a'), join(dir, 'a'))).toBe(false);
    expect(isInside(join(dir, 'a'), join(dir, 'a', 'b'))).toBe(false);
    expect(isInside(join(dir, 'ab'), join(dir, 'a'))).toBe(false);
    expect(sameFile(join(dir, 'a', '..', 'a'), join(dir, 'a'))).toBe(true);
  });

  it('finds a file that differs only in case, whatever the filesystem', () => {
    const dir = tmp('case');
    writeFileSync(join(dir, 'coin.wav'), '');
    expect(caseCollision(join(dir, 'Coin.wav'))).toBe('coin.wav');
    expect(caseCollision(join(dir, 'coin.wav'))).toBeUndefined();
    expect(caseCollision(join(dir, 'other.wav'))).toBeUndefined();
    expect(caseCollision(join(dir, 'missing', 'x.wav'))).toBeUndefined();
  });

  it('refuses an output of the wrong type, an input, something around an input, and a case twin', () => {
    const dir = tmp('safe');
    const input = join(dir, 'in');
    mkdirSync(input);
    writeFileSync(join(dir, 'coin.wav'), '');
    expect(thrown(() => requireSafeOutput(join(dir, 'out.mp3'), { ext: '.wav' }, '--wav'))).toMatchObject({ code: 'E_USAGE' });
    expect(() => requireSafeOutput(join(dir, 'OUT.WAV'), { ext: '.wav' })).not.toThrow();
    expect(thrown(() => requireSafeOutput(input, { inputs: [input] }))).toMatchObject({ code: 'E_CONFLICT' });
    expect(thrown(() => requireSafeOutput(join(input, 'x.wav'), { inputs: [input] }))).toMatchObject({ code: 'E_CONFLICT' });
    expect(thrown(() => requireSafeOutput(dir, { inputs: [input] }))).toMatchObject({ code: 'E_CONFLICT' });
    expect(thrown(() => requireSafeOutput(join(dir, 'Coin.wav'), { ext: '.wav' }))).toMatchObject({ code: 'E_CONFLICT', hint: expect.stringContaining('coin.wav') });
    expect(() => requireSafeOutput(join(dir, 'coin.wav'), { ext: '.wav' })).not.toThrow();
  });

  it('keeps a re-encode out of its own source', () => {
    const dir = tmp('dirs');
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    for (const [s, o] of [[join(dir, 'a'), join(dir, 'a')], [join(dir, 'a'), join(dir, 'a', 'b')], [join(dir, 'a', 'b'), join(dir, 'a')]]) {
      expect(thrown(() => requireDistinctDirs(s, o)), `${s} -> ${o}`).toMatchObject({ code: 'E_USAGE' });
    }
    expect(() => requireDistinctDirs(join(dir, 'a'), join(dir, 'c'))).not.toThrow();
  });

  it('is applied by the commands that write a path they were given', () => {
    const dir = project();
    add(dir, coin());
    expect(beeps(dir, 'export', 'coin', '--wav', join(dir, 'coin.mp3')).err.code).toBe('E_USAGE');
    expect(beeps(dir, 'look', 'coin', '--out', join(dir, 'coin.jpg')).err.code).toBe('E_USAGE');
    const bundle = join(dir, 'bundle');
    mkdirSync(bundle);
    expect(beeps(dir, 'compress', bundle, bundle).err.code).toBe('E_USAGE');
    expect(beeps(dir, 'compress', bundle, join(bundle, 'out')).err.code).toBe('E_USAGE');
    writeFileSync(join(dir, 'coin.json'), '{}');
    expect(beeps(dir, 'family', join(dir, 'x.json'), '--row', 'name=a', '--out', dir, '--dry-run').err?.code).not.toBe('E_CONFLICT');
  });
});

describe('the generated reference', () => {
  it('is current', () => {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'gen-reference-docs.mjs'), '--check'], { encoding: 'utf8', windowsHide: true });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('lists every archetype with its recipe, and every archetype file has one', () => {
    const doc = readFileSync(join(root, 'docs', 'reference.md'), 'utf8');
    const all = loadArchetypes();
    expect(all.length).toBeGreaterThan(20);
    for (const a of all) {
      expect(a.recipe.length, a.name).toBeGreaterThanOrEqual(20);
      expect(doc, a.name).toContain(`| \`${a.name}\` |`);
    }
  });

  it('refuses an archetype file with no recipe', () => {
    const dir = tmp('arch');
    const a = JSON.parse(readFileSync(join(ARCHETYPES_DIR, 'coin.json'), 'utf8'));
    delete a.recipe;
    writeFileSync(join(dir, 'coin.json'), JSON.stringify(a));
    expect(thrown(() => loadArchetypes(dir))).toMatchObject({ code: 'E_SCHEMA' });
  });

  it('is what the compose skill points at', () => {
    const skill = readFileSync(join(root, 'skills', 'beeps-compose', 'SKILL.md'), 'utf8');
    expect(skill).toContain('docs/reference.md');
    expect(skill).toContain('references/worked-examples.md');
    expect(skill.split('\n').length).toBeLessThanOrEqual(150);
  });
});

describe('the worked examples', () => {
  const commands = leafCommands(buildProgram({ emit() {}, projectDir: () => process.cwd() })).map(c => c.name);
  const text = readFileSync(join(root, 'skills', 'beeps-compose', 'references', 'worked-examples.md'), 'utf8');
  const lines = [...text.matchAll(/```text\n([\s\S]*?)```/g)].flatMap(m => m[1].split('\n')).filter(l => l.startsWith('beeps '));

  it('has command lines to check', () => {
    expect(lines.length).toBeGreaterThan(10);
  });

  it('uses only commands the CLI has', () => {
    const missing = lines.filter(l => {
      const words = l.replace(/#.*/, '').trim().split(/\s+/).slice(1);
      return !commands.some(c => { const parts = c.split(' '); return parts.every((p, i) => words[i] === p); });
    });
    expect(missing).toEqual([]);
  });

  it('uses only flags the command declares', () => {
    const program = buildProgram({ emit() {}, projectDir: () => process.cwd() });
    const find = (words: string[]) => {
      let cmd = program;
      for (const w of words) { const next = cmd.commands.find(c => c.name() === w); if (!next) break; cmd = next; }
      return cmd;
    };
    const bad: string[] = [];
    for (const l of lines) {
      const words = l.replace(/#.*/, '').trim().split(/\s+/).slice(1);
      const cmd = find(words);
      const known = new Set(cmd.options.map(o => o.long));
      for (const w of words.filter(x => x.startsWith('--'))) if (!known.has(w)) bad.push(`${l} -> ${w}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('what the highest notes do to an instrument', () => {
  const bright = patch({ ...PAD, name: 'bright', layers: [{ source: { type: 'osc', wave: 'sawtooth', pitch: 'C4' }, amp: { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.2 }, filter: { type: 'lowpass', cutoff: 12000, resonanceDb: 0 } }] });
  const rich = patch({ ...PAD, name: 'rich', layers: [{ source: { type: 'additive', pitch: 'C4', partials: [[1, 0, 0.3], [8, -6, 0.1]] }, amp: { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.2 } }] });
  const high = (notes: string, extra: Record<string, unknown> = {}) => song({
    patterns: { 'pad-a': { bars: 2, notes: [[0, notes, 1]] }, 'hat-a': { bars: 1, steps: 'x...' } },
    tracks: { pad: { instrument: PAD, ...extra }, hat: { instrument: PAD } },
  });

  it('is quiet for notes that stay in range', () => {
    expect(registerNotices(high('C4'), { pad: bright, hat: bright }, 48000)).toEqual([]);
  });

  it('reports a partial that lands above 0.45 of the sample rate at the top note', () => {
    const s = high('C8');
    expect(registerNotices(s, { pad: bright, hat: bright }, 48000).map(n => n.code)).not.toContain('N_PARTIAL_ABOVE_NYQUIST');
    const out = registerNotices(s, { pad: rich, hat: rich }, 48000);
    expect(out.map(n => n.code)).toContain('N_PARTIAL_ABOVE_NYQUIST');
    expect(out.find(n => n.code === 'N_PARTIAL_ABOVE_NYQUIST')!.pointer).toBe('/tracks/pad');
  });

  it('reports a keytracked cutoff the engine would cap, only when the track keytracks', () => {
    expect(registerNotices(high('C7'), { pad: bright, hat: bright }, 48000).map(n => n.code)).not.toContain('N_CUTOFF_CAPPED');
    const out = registerNotices(high('C7', { keytrack: 1 }), { pad: bright, hat: bright }, 48000);
    expect(out.map(n => n.code)).toContain('N_CUTOFF_CAPPED');
  });

  it('has registered both codes', () => {
    expect(NOTICE_CODES).toEqual(expect.arrayContaining(['N_PARTIAL_ABOVE_NYQUIST', 'N_CUTOFF_CAPPED']));
  });
});
