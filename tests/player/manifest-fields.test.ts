import { describe, expect, it } from 'vitest';
import { ExportManifestSchema } from '../../src/export-manifest.ts';

const base = {
  schema: 'beeps/audio-asset@1', id: 'coin', label: 'Coin', description: '', role: 'sfx', file: 'coin.wav', loop: false,
  durationSec: 0.3, sampleRate: 48000, channels: 2, renderKey: 'k', loudness: { metric: 'momentary-max', lufs: -18 },
  truePeakDb: -3, normalizationAlreadyApplied: true,
};

describe('audio asset sidecar fields', () => {
  it('still accepts sidecars written before the optional fields existed', () => {
    expect(ExportManifestSchema.safeParse(base).success).toBe(true);
  });

  it('accepts priority, variants, no-repeat, tempo and adaptive layers', () => {
    const r = ExportManifestSchema.safeParse({
      ...base, priority: 4, noRepeat: true, variants: [{ file: 'coin.0.wav', weight: 2 }, { file: 'coin.1.wav' }],
      bpm: 120, meter: 4, layers: [{ name: 'bed', file: 'theme.bed.wav' }], states: { calm: ['bed'] }, initialState: 'calm',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an out-of-range priority and an empty variant list', () => {
    expect(ExportManifestSchema.safeParse({ ...base, priority: 9 }).success).toBe(false);
    expect(ExportManifestSchema.safeParse({ ...base, variants: [] }).success).toBe(false);
  });
});
