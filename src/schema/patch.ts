import { z } from 'zod';

const NOTE = /^[A-G](#|b)?-?\d$/;
export const Pitch = z.union([
  z.string().regex(NOTE, 'note names look like E6, F#5 or Bb3'),
  z.number().positive().max(24000),
]);

const Amp = z.strictObject({
  attack: z.number().min(0).max(10).default(0.005),
  decay: z.number().min(0).max(10).default(0.1),
  sustain: z.number().min(0).max(1).default(0),
  release: z.number().min(0).max(10).default(0.02),
});

const FilterEnv = z.strictObject({ to: z.number().positive().max(24000), time: z.number().positive().max(10) });
// Chromium applies lowpass/highpass Q as a resonance in dB, but bandpass/notch/peaking Q as a true
// quality factor. Naming them differently stops agents carrying one meaning into the other.
const ResonantFilter = z.strictObject({
  type: z.enum(['lowpass', 'highpass']),
  cutoff: z.number().positive().max(24000),
  resonanceDb: z.number().min(-20).max(30).default(0),
  env: FilterEnv.optional(),
});
const QFilter = z.strictObject({
  type: z.enum(['bandpass', 'notch', 'peaking']),
  cutoff: z.number().positive().max(24000),
  q: z.number().positive().max(100).default(1),
  gainDb: z.number().min(-40).max(40).optional(),
  env: FilterEnv.optional(),
});
const Filter = z.union([ResonantFilter, QFilter]);

export const REVERB_PRESET_NAMES = ['small', 'room', 'hall', 'cave', 'space'] as const;

const Wave = z.enum(['sine', 'square', 'sawtooth', 'triangle']);

const Osc = z.strictObject({
  type: z.literal('osc'),
  wave: Wave,
  pitch: Pitch,
  unison: z.strictObject({ voices: z.number().int().min(1).max(7), detuneCents: z.number().min(0).max(100) }).optional(),
});
/** Opt-in decorrelated stereo: true is full width, a number 0..1 is partial (channel correlation sqrt(1-width)). Absent: mono, as before. */
const Stereo = z.union([z.boolean(), z.number().min(0).max(1)]);
const Noise = z.strictObject({ type: z.literal('noise'), color: z.enum(['white', 'pink', 'brown']).default('white'), stereo: Stereo.optional() });
const Fm = z.strictObject({
  type: z.literal('fm'),
  pitch: Pitch,
  operators: z.array(z.strictObject({
    ratio: z.number().positive().max(32),
    index: z.number().min(0).max(50).default(1),
    wave: Wave.default('sine'),
  })).min(2).max(4),
  /** Edges [from, to]: operator `from` modulates the frequency of operator `to`. Operator 0 is the audible carrier. */
  algorithm: z.array(z.tuple([z.number().int().min(0).max(3), z.number().int().min(0).max(3)])).min(1),
});
const Additive = z.strictObject({
  type: z.literal('additive'),
  pitch: Pitch,
  /** [ratio to pitch, gain dB, decay seconds] */
  partials: z.array(z.tuple([z.number().positive().max(64), z.number().min(-80).max(0), z.number().positive().max(10)])).min(1).max(64),
});
const Modal = z.strictObject({
  type: z.literal('modal'),
  pitch: Pitch,
  /** [ratio to pitch, q, gain dB]: resonant modes struck by the exciter */
  modes: z.array(z.tuple([z.number().positive().max(64), z.number().positive().max(1000), z.number().min(-80).max(12)])).min(1).max(32),
  exciter: z.enum(['impulse', 'noiseBurst']).default('impulse'),
});
const Grains = z.strictObject({
  type: z.literal('grains'),
  /** mean grains per second (Poisson arrivals) */
  rate: z.number().positive().max(5000),
  grainDecay: z.number().positive().max(1),
  center: z.number().positive().max(24000),
  q: z.number().positive().max(100).default(1),
  /** rate multiplier reached at the end of the sound, e.g. 0.1 thins out to a trickle */
  rateEnd: z.number().min(0).max(10).optional(),
  stereo: Stereo.optional(),
});
const Voice = z.strictObject({
  type: z.literal('voice'),
  /** Fundamental (f0); a layer's pitchEnv draws the f0 contour. */
  pitch: Pitch,
  /** [centre Hz, q, gain dB]: 2-4 parallel bandpass resonances (the vocal tract). They stay put when the f0 moves. */
  formants: z.array(z.tuple([z.number().positive().max(12000), z.number().positive().max(30), z.number().min(-40).max(12)])).min(2).max(4),
  /** Glottal spectral slope: harmonic n has amplitude 1/n^tilt. Low is buzzy and raspy, high is soft and hooty. */
  tilt: z.number().min(0.5).max(3).default(1.5),
  /** Seeded random pitch wobble of the pulse train, in cents (about 50 Hz smoothed): roughness and age. */
  jitterCents: z.number().min(0).max(100).default(0),
  vibrato: z.strictObject({ rate: z.number().positive().max(40), cents: z.number().min(0).max(600) }).optional(),
  tremolo: z.strictObject({ rate: z.number().positive().max(120), depth: z.number().min(0).max(1) }).optional(),
  /** 0..1 mix of seeded breath noise through the same formants, in place of pulse energy. 1 is a whisper or hiss. */
  breath: z.number().min(0).max(1).default(0),
});
const Metal = z.strictObject({
  type: z.literal('metal'),
  base: z.number().positive().max(2000).default(40),
  bands: z.tuple([z.number().positive().max(24000), z.number().positive().max(24000)]).default([3440, 7100]),
});

export const SOURCE_TYPES = ['osc', 'noise', 'fm', 'additive', 'modal', 'grains', 'metal', 'voice'] as const;
const Source = z.discriminatedUnion('type', [Osc, Noise, Fm, Additive, Modal, Grains, Metal, Voice]);

const PitchPoint = z.strictObject({ at: z.number().min(0).max(10), to: Pitch, curve: z.enum(['linear', 'exp', 'step']).default('exp') });

const Layer = z.strictObject({
  source: Source,
  start: z.number().min(0).max(10).default(0),
  gainDb: z.number().min(-60).max(12).default(0),
  pitchEnv: z.array(PitchPoint).max(16).optional(),
  amp: Amp,
  filter: Filter.optional(),
  /** Opt-in highpass (Hz, resonance 0) after the amp envelope, so a lowpassed layer can also lose its sub-audible content (one `filter` per layer). Absent: the graph is unchanged. */
  highpass: z.number().min(10).max(2000).optional(),
  lfo: z.strictObject({ target: z.enum(['pitch', 'gain', 'cutoff']), rate: z.number().positive().max(200), depth: z.number().min(0) }).optional(),
  drive: z.number().min(0).max(1).optional(),
  pan: z.number().min(-1).max(1).optional(),
});

export const PatchSchema = z.strictObject({
  schema: z.literal('beeps/patch@1'),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  family: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  archetype: z.string().optional(),
  tags: z.array(z.string()).default([]),
  duration: z.number().min(0.01).max(10),
  layers: z.array(Layer).min(1).max(8),
  fx: z.strictObject({
    delay: z.strictObject({ time: z.number().positive().max(2), feedback: z.number().min(0).max(0.9), sendDb: z.number().min(-60).max(0) }).optional(),
    reverb: z.strictObject({ preset: z.enum(REVERB_PRESET_NAMES), sendDb: z.number().min(-60).max(0) }).optional(),
    /** Opt-in DC blocker (one pole, about 10 Hz) on the layer mix, before the effects. Absent: the graph is exactly as before. */
    dcBlock: z.boolean().optional(),
  }).optional(),
  variation: z.strictObject({
    pitchCents: z.number().min(0).max(1200).default(0),
    gainDb: z.number().min(0).max(12).default(0),
    variants: z.number().int().min(1).max(16).default(1),
    noRepeat: z.boolean().default(true),
    /** Relative play probability per variant (Halo-style permutation weighting). */
    weights: z.array(z.number().min(0)).optional(),
  }).optional(),
  meta: z.strictObject({
    priority: z.number().int().min(1).max(5).default(3),
    intent: z.enum(['click', 'oneshot', 'bed']).default('oneshot'),
    description: z.string().optional(),
    /** Loudness offset (LU) for this patch alone, added to its family's offset: a soft variant of a family that otherwise lands at the same level. Absent: no change. */
    loudnessOffsetDb: z.number().min(-30).max(12).optional(),
    /** Hand-made variants authored as separate patches: siblings share this value (and the family). Names like <stem>-<n> group without it. */
    variantOf: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes').optional(),
  }).optional(),
});

export type Patch = z.output<typeof PatchSchema>;
export type PatchInput = z.input<typeof PatchSchema>;
export type Layer = Patch['layers'][number];
export type Source = Layer['source'];

export interface Issue { pointer: string; message: string; hint?: string }
export type ParseResult = { ok: true; patch: Patch } | { ok: false; issues: Issue[] };

export const pointerOf = (path: readonly PropertyKey[]): string =>
  path.length ? '/' + path.map(p => String(p).replaceAll('~', '~0').replaceAll('/', '~1')).join('/') : '';

type ZIssue = z.core.$ZodIssue;

function hintFor(issue: ZIssue): string | undefined {
  const keys: string[] = issue.code === 'unrecognized_keys' ? issue.keys : [];
  if (keys.includes('q')) return 'lowpass/highpass take resonanceDb (Chromium treats their Q as dB); bandpass/notch/peaking take q';
  if (keys.includes('resonanceDb')) return 'bandpass/notch/peaking take q (a true quality factor); only lowpass/highpass take resonanceDb';
  if (keys.some(k => ['gain', 'volume', 'loudness', 'level'].includes(k))) {
    return 'patches never carry a loudness literal: use gainDb for relative balance; the renderer trims every sound to the project loudness target';
  }
  const last = issue.path[issue.path.length - 1];
  if (last === 'type' && issue.path.includes('source')) return `source.type is one of ${SOURCE_TYPES.join(', ')}`;
  if (last === 'pitch' || last === 'to') return 'pitch is a note name like E6 or a number in Hz';
  return undefined;
}

/** Unions report failures at the union's own path; surface the most specific branch failure instead. */
function deepest(issue: ZIssue): ZIssue {
  if (issue.code !== 'invalid_union') return issue;
  let best: ZIssue | undefined;
  for (const branch of issue.errors) for (const e of branch) {
    const d = deepest(e);
    if (!best || d.code === 'unrecognized_keys' || (best.code !== 'unrecognized_keys' && d.path.length > best.path.length)) best = d;
  }
  return best ? ({ ...best, path: [...issue.path, ...best.path] } as ZIssue) : issue;
}

export function parsePatch(input: unknown): ParseResult {
  const r = PatchSchema.safeParse(input);
  if (r.success) return { ok: true, patch: r.data };
  const issues = r.error.issues.map(raw => {
    const issue = deepest(raw);
    const hint = hintFor(issue);
    return { pointer: pointerOf(issue.path), message: issue.message, ...(hint ? { hint } : {}) };
  });
  return { ok: false, issues };
}

export function patchJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PatchSchema, { io: 'input' }) as Record<string, unknown>;
}
