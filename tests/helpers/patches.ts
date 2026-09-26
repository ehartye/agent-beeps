import type { Patch } from '../../src/schema/patch.ts';
import { parsePatch } from '../../src/schema/patch.ts';

/** Parse test fixtures through the real schema so defaults are filled exactly as in production. */
export function patch(input: unknown): Patch {
  const r = parsePatch(input);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.patch;
}

export const coin = (): Patch => patch({
  schema: 'beeps/patch@1', name: 'coin', family: 'coin', duration: 0.3,
  layers: [{
    source: { type: 'osc', wave: 'square', pitch: 'E6' },
    pitchEnv: [{ at: 0.06, to: 'B6', curve: 'step' }],
    amp: { attack: 0.004, decay: 0.12, sustain: 0, release: 0.05 },
    filter: { type: 'lowpass', cutoff: 6000, resonanceDb: 0 },
  }],
});

/** One steady tone with a flat envelope, for Chromium fact tests. */
export const tone = (wave: 'sine' | 'square' | 'sawtooth' | 'triangle', hz: number, extra: Record<string, unknown> = {}): Patch => patch({
  schema: 'beeps/patch@1', name: `tone-${wave}`, family: 'test', duration: 0.5,
  layers: [{ source: { type: 'osc', wave, pitch: hz }, amp: { attack: 0.01, decay: 0, sustain: 1, release: 0.01 }, ...extra }],
});

export const withSource = (source: Record<string, unknown>, extra: Record<string, unknown> = {}): Patch => patch({
  schema: 'beeps/patch@1', name: `src-${String(source.type)}`, family: 'test', duration: 0.3,
  layers: [{ source, amp: { attack: 0.005, decay: 0.2, sustain: 0, release: 0.05 }, ...extra }],
});
