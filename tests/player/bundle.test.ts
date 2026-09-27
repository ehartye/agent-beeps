// tests/player/bundle.test.ts
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleDir } from '../../src/bundle.ts';

const sidecar = (id: string, file: string, extra: Record<string, unknown> = {}) => ({
  schema: 'beeps/audio-asset@1', id, label: id, description: '', role: 'sfx', file, loop: false, durationSec: 0.3,
  sampleRate: 48000, channels: 2, renderKey: 'k', loudness: { metric: 'momentary-max', lufs: -18 }, truePeakDb: -3,
  normalizationAlreadyApplied: true, ...extra,
});

describe('beeps bundle', () => {
  it('collects sidecars into one catalog with paths relative to the bundle directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-'));
    mkdirSync(join(dir, 'sfx'));
    writeFileSync(join(dir, 'sfx', 'coin.wav.json'), JSON.stringify(sidecar('coin', 'coin.0.wav', { variants: [{ file: 'coin.0.wav' }, { file: 'coin.1.wav' }] })));
    writeFileSync(join(dir, 'theme.wav.json'), JSON.stringify(sidecar('theme', 'theme.wav', { role: 'music', loop: true, layers: [{ name: 'bed', file: 'theme.bed.wav' }] })));
    const r = bundleDir(dir);
    expect(r.assets.sort()).toEqual(['coin', 'theme']);
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    expect(index.schema).toBe('beeps/audio-bundle@1');
    expect(index.assets.coin).toMatchObject({ file: 'sfx/coin.0.wav', variants: [{ file: 'sfx/coin.0.wav' }, { file: 'sfx/coin.1.wav' }] });
    expect(index.assets.theme.layers).toEqual([{ name: 'bed', file: 'theme.bed.wav' }]);
  });

  it('refuses duplicate ids and names both files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-dup-'));
    writeFileSync(join(dir, 'a.wav.json'), JSON.stringify(sidecar('coin', 'a.wav')));
    writeFileSync(join(dir, 'b.wav.json'), JSON.stringify(sidecar('coin', 'b.wav')));
    expect(() => bundleDir(dir)).toThrow(/"coin" is in both a\.wav\.json and b\.wav\.json/);
  });

  it('refuses a file that is not a sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-bad-'));
    writeFileSync(join(dir, 'x.wav.json'), JSON.stringify({ hello: 1 }));
    expect(() => bundleDir(dir)).toThrow(/x\.wav\.json: not a beeps\/audio-asset@1 sidecar/);
  });
});
