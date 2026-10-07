import { describe, expect, it } from 'vitest';
import { summary } from '../src/commands/shared.ts';
import type { Rendered } from '../src/render/pipeline.ts';
import { coin } from './helpers/patches.ts';

const rendered = (delivered: Record<string, unknown>): Rendered => ({
  key: 'k', patch: coin(), seed: 1, variant: 0, trimDb: -3, dir: 'd', wavPath: 'd/delivered.wav', lookPath: 'd/look.png',
  features: { energyLengthSec: 0.1, attackSec: 0.004, tailSec: 0.2, centroidHz: 2000, sharpness: 1, roughness: 0.1, flatness: 0.1, pitchStrength: 0, pitchHz: 0, pitchDirection: 0,
    delivered: { samplePeakDb: -2, truePeakDb: -1.7, momentaryMaxLufs: -19.5, clippedSamples: 0, ...delivered } } as unknown as Rendered['features'],
});

describe('render summary', () => {
  it('says whether the loudness trim was capped by the true-peak ceiling', () => {
    expect(summary(rendered({ peakLimited: true })).features.peakLimited).toBe(true);
    expect(summary(rendered({})).features.peakLimited).toBe(false);
  });
});
