import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { initProject, savePatch } from '../src/project.ts';
import { chromiumAvailable } from '../src/render/host.ts';
import { coin } from './helpers/patches.ts';
import { songInput } from './helpers/songs.ts';

const bin = join(import.meta.dirname, '..', 'scripts/beeps.mjs');
const hasChromium = await chromiumAvailable();
const project = () => initProject(mkdtempSync(join(tmpdir(), 'beeps-manifest-')));
function run(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { ...r, data: r.stdout.trim() ? JSON.parse(r.stdout) : undefined };
}

describe('export manifests', () => {
  it.each(['export', 'song export'])('rejects invalid roles and a role without --manifest for %s before exporting', command => {
    const p = project();
    const dest = join(p.paths.root, 'missing.wav');
    for (const flags of [['--manifest', '--role', 'speech'], ['--role', 'ambience']]) {
      const r = run(p.paths.root, ...command.split(' '), 'missing', '--wav', dest, ...flags);
      expect(r.status).not.toBe(0);
      expect(JSON.parse(r.stderr).error).toMatchObject({ code: 'E_USAGE', message: expect.stringMatching(/role/) });
      expect(existsSync(dest)).toBe(false);
    }
  });

  it.skipIf(!hasChromium)('adds a portable patch sidecar without changing the delivered WAV or ordinary export output', () => {
    const p = project();
    savePatch(p, { ...coin(), meta: { priority: 3, intent: 'oneshot', description: 'A seed settles into the garden.' } });
    const plain = run(p.paths.root, 'export', 'coin', '--wav', 'audio/plain.wav', '--seed', '7');
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.data).not.toHaveProperty('manifest');
    expect(existsSync(join(p.paths.root, 'audio/plain.wav.json'))).toBe(false);
    const ex = run(p.paths.root, 'export', 'coin', '--wav', 'audio/seed.wav', '--seed', '7', '--manifest');
    expect(ex.status, ex.stderr).toBe(0);
    expect(ex.data.manifest).toBe(join(p.paths.root, 'audio/seed.wav.json'));
    const manifest = JSON.parse(readFileSync(ex.data.manifest, 'utf8'));
    const wav = readFileSync(ex.data.wav);
    expect(manifest).toMatchObject({ schema: 'beeps/audio-asset@1', id: 'coin', label: 'Coin',
      description: 'A seed settles into the garden.', role: 'sfx', file: 'seed.wav', loop: false,
      sampleRate: wav.readUInt32LE(24), channels: wav.readUInt16LE(22), renderKey: ex.data.key,
      loudness: { metric: 'momentary-max', lufs: ex.data.features.loudnessLufs },
      truePeakDb: ex.data.features.truePeakDb, normalizationAlreadyApplied: true });
    expect(manifest.durationSec).toBe(wav.readUInt32LE(40) / wav.readUInt16LE(32) / wav.readUInt32LE(24));
    expect(wav).toEqual(readFileSync(plain.data.wav));
    expect(manifest).not.toHaveProperty('trimDb');
    const moved = mkdtempSync(join(tmpdir(), 'beeps-moved-audio-'));
    cpSync(dirname(ex.data.wav), moved, { recursive: true });
    const movedManifest = JSON.parse(readFileSync(join(moved, basename(ex.data.manifest)), 'utf8'));
    expect(readFileSync(join(moved, movedManifest.file))).toEqual(wav);
    const ambience = run(p.paths.root, 'export', 'coin', '--wav', 'audio/bed.wav', '--seed', '7', '--manifest', '--role', 'ambience');
    expect(ambience.status, ambience.stderr).toBe(0);
    expect(JSON.parse(readFileSync(ambience.data.manifest, 'utf8'))).toMatchObject({ role: 'ambience', loop: false });
  });

  it.skipIf(!hasChromium).each([false, true])('exports song identity, delivered measurements and actual loop state (loop=%s)', loop => {
    const p = project();
    writeFileSync(join(p.paths.root, 'garden.json'), JSON.stringify(songInput({ title: loop ? 'Small Worlds' : '', description: 'A quiet garden under glass.', loop })));
    const flags = loop ? ['--role', 'ambience'] : [];
    const ex = run(p.paths.root, 'song', 'export', 'garden.json', '--wav', 'audio/garden.wav', '--manifest', ...flags);
    expect(ex.status, ex.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(ex.data.manifest, 'utf8'));
    const meta = JSON.parse(readFileSync(join(dirname(ex.data.renderedWav), 'meta.json'), 'utf8'));
    expect(manifest).toMatchObject({ schema: 'beeps/audio-asset@1', id: 'test-song', label: loop ? 'Small Worlds' : 'Test song',
      description: 'A quiet garden under glass.', role: loop ? 'ambience' : 'music', file: 'garden.wav', loop,
      sampleRate: 48000, channels: 2, normalizationAlreadyApplied: true,
      loudness: { metric: 'integrated', lufs: meta.features.delivered.integratedLufs }, truePeakDb: meta.features.delivered.truePeakDb });
    expect(manifest.renderKey).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(ex.data.wav)).toEqual(readFileSync(ex.data.renderedWav));
    const plain = run(p.paths.root, 'song', 'export', 'garden.json', '--wav', 'audio/plain.wav');
    expect(plain.status, plain.stderr).toBe(0);
    expect(Object.keys(plain.data).sort()).toEqual(['durationSec', 'loop', 'name', 'renderedWav', 'wav']);
    expect(existsSync(`${plain.data.wav}.json`)).toBe(false);
    expect(readFileSync(plain.data.wav)).toEqual(readFileSync(ex.data.wav));
  });
});
