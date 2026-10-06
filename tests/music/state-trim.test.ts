import { describe, expect, it } from 'vitest';
import { stateSong, stateTrim } from '../../src/render/layers.ts';
import { song } from '../helpers/songs.ts';

const SR = 48000;
const sine = (amp: number, sec = 4) => [Float32Array.from({ length: SR * sec }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / SR))];

describe('stateTrim', () => {
  it('brings a quiet state up to the target, and a loud one down', () => {
    const quiet = stateTrim(sine(0.02), SR, -20);
    expect(quiet.trimDb).toBeGreaterThan(5);
    expect(quiet.lufs).toBeLessThan(-30);
    const loud = stateTrim(sine(0.5), SR, -30);
    expect(loud.trimDb).toBeLessThan(-5);
  });

  it('never lifts a state above -1.5 dBFS sample peak or beyond 12 dB', () => {
    const peaky = sine(0.5); // peak -6 dBFS: at most 4.5 dB of headroom
    expect(stateTrim(peaky, SR, -5).trimDb).toBeLessThanOrEqual(4.5);
    expect(stateTrim(sine(0.001), SR, -5).trimDb).toBe(12);
  });

  it('reads silence as no trim', () => {
    expect(stateTrim([new Float32Array(SR)], SR, -20)).toEqual({ lufs: -99, peakDb: -99, trimDb: 0 });
  });
});

describe('stateSong', () => {
  it('keeps only the state tracks, their patterns and sections, and drops the adaptive block', () => {
    const s = song({ loop: true,
      adaptive: { layers: { a: ['pad'], b: ['hat'] }, states: { calm: ['a'], busy: ['a', 'b'] }, initial: 'calm' },
    });
    const calm = stateSong(s, ['pad']);
    expect(Object.keys(calm.tracks)).toEqual(['pad']);
    expect(Object.keys(calm.patterns)).toEqual(['pad-a']);
    expect(Object.keys(calm.sections.a.play)).toEqual(['pad']);
    expect(calm.adaptive).toBeUndefined();
    expect(s.adaptive).toBeDefined(); // the original is untouched
  });
});
