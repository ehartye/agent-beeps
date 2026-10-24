// The 0.34.0 acoustic-style instruments, played by a song: every one renders to audible, finite, un-clipped audio with no lint errors.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../../src/project.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { songInput } from '../helpers/songs.ts';

const hasChromium = await chromiumAvailable();
const bin = join(import.meta.dirname, '..', '..', 'scripts/beeps.mjs');

// Each instrument gets a short phrase in its own register.
const PHRASES: Record<string, { gainDb: number; notes: [number, string, number, number][] }> = {
  'upright-bass': { gainDb: -8, notes: [[0, 'C2', 1, 1], [1, 'G2', 1, 1], [2, 'A2', 1, 1], [3, 'E2', 1, 1]] },
  'dist-bass': { gainDb: -12, notes: [[0, 'E1', 0.5, 1], [0.5, 'E1', 0.5, 1], [1, 'G1', 1, 1], [2, 'A1', 2, 1]] },
  vibraphone: { gainDb: -10, notes: [[0, 'C4', 1, 1], [1, 'E4', 1, 1], [2, 'G4', 1, 1], [3, 'B4', 1, 1]] },
  organ: { gainDb: -14, notes: [[0, 'C3', 4, 1]] },
  'acoustic-guitar': { gainDb: -10, notes: [[0, 'E3', 1, 1], [1, 'A3', 1, 1], [2, 'D4', 1, 1], [3, 'G3', 1, 1]] },
  'clean-guitar': { gainDb: -10, notes: [[0, 'E3', 1, 1], [1, 'G3', 1, 1], [2, 'B3', 1, 1], [3, 'E4', 1, 1]] },
  'power-chord-muted': { gainDb: -14, notes: [[0, 'E2', 0.25, 1], [0.5, 'E2', 0.25, 1], [1, 'G2', 0.25, 1], [1.5, 'E2', 0.25, 1], [2, 'A2', 0.25, 1], [3, 'E2', 0.25, 1]] },
  'power-chord-open': { gainDb: -16, notes: [[0, 'E2', 2, 1], [2, 'A2', 2, 1]] },
  'lead-guitar': { gainDb: -14, notes: [[0, 'E4', 1, 1], [1, 'G4', 1, 1], [2, 'A4', 2, 1]] },
  'brush-snare': { gainDb: -12, notes: [[1, 'C3', 0.25, 1], [3, 'C3', 0.25, 1]] },
  ride: { gainDb: -16, notes: [[0, 'C3', 0.5, 1], [1, 'C3', 0.5, 0.7], [2, 'C3', 0.5, 1], [3, 'C3', 0.5, 0.7]] },
  'metal-snare': { gainDb: -12, notes: [[1, 'C3', 0.25, 1], [3, 'C3', 0.25, 1]] },
};

describe.skipIf(!hasChromium)('acoustic-style library instruments in a song', () => {
  it('render audible, finite, un-clipped audio with no lint errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-acoustic-'));
    initProject(dir);
    const tracks: Record<string, unknown> = {}, patterns: Record<string, unknown> = {}, play: Record<string, string> = {};
    for (const [name, { gainDb, notes }] of Object.entries(PHRASES)) {
      tracks[name] = { instrument: name, gainDb };
      patterns[`${name}-a`] = { bars: 1, notes };
      play[name] = `${name}-a`;
    }
    const song = songInput({ name: 'acoustic-check', bpm: 100, tracks, patterns, sections: { a: { bars: 2, play } }, loop: false });
    const file = join(dir, 'acoustic-check.json');
    writeFileSync(file, JSON.stringify(song));
    const r = spawnSync(process.execPath, [bin, 'song', 'render', file], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 280000 });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout).songs[0];
    expect(out.lint.errors).toEqual([]);
    expect(Number.isFinite(out.features.truePeakDb)).toBe(true);
    expect(out.features.truePeakDb).toBeLessThan(0);
    expect(out.features.clippedSamples ?? 0).toBe(0);
    expect(out.notices ?? []).not.toContainEqual(expect.objectContaining({ code: 'N_UNUSED_FIELD' }));
  }, 300000);
});
