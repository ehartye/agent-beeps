// Patch expectations: the `xExpect` block of a patch checked against what the sound measures like (docs/expectations.md).
// Pure functions over `Features`, the numbers `measure` already prints, so a verdict is reproducible from a measure call. Each entry
// has three outcomes: pass, fail, or unmeasurable (the feature cannot be trusted for this sound: pitch on noise). Unmeasurable counts as
// a failure, because a contract that cannot be checked is not met.
import { noteToHz } from '../runtime/engine/notes.js';
import type { Features } from './measure/index.ts';
import type { Expectation, ExpectKind, Patch } from './schema/patch.ts';

export type Outcome = 'pass' | 'fail' | 'unmeasurable';

/** What one entry of the block found, with the JSON pointer of the entry so the agent edits the exact line. */
export interface Verdict {
  kind: ExpectKind;
  outcome: Outcome;
  pointer: string;
  /** Unit of `actual` and of the numbers in `expected`; absent for yes/no checks. */
  unit?: string;
  expected: Record<string, unknown>;
  actual: number | string | boolean | null;
  /** pitch: how far the measured pitch is from the target, in cents, and the target; pitch-direction: the measured movement. */
  offCents?: number;
  targetHz?: number;
  semitones?: number;
  /** The variant that failed (the first, when several do); absent when the patch declares one variant or all variants pass. */
  variant?: number;
  /** Why the check could not be made, for `unmeasurable`. */
  reason?: string;
  /** Which parameters move the measurement, for a failure. */
  hint?: string;
}

export interface ExpectationReport {
  passed: boolean;
  checks: Verdict[];
  /** Variants that failed to render, so were not checked (set by the caller that renders them). */
  unrendered?: number[];
}

/** Pitch counts as measured at or above this strength (the repo's convention for "pitched", used by every pitch readout). */
export const PITCHED_STRENGTH = 0.7;
/** A pitch moving less than this many semitones start to end is `steady`. */
export const STEADY_BAND_SEMITONES = 0.5;
/** The default `true-peak` ceiling and its tolerance: the craft rule true-peak-ceiling (-1 dBTP, 0.1 dB for rounding). */
export const TRUE_PEAK_CEILING_DB = -1;
export const TRUE_PEAK_TOLERANCE_DB = 0.1;

const direction = (semitones: number): 'rising' | 'falling' | 'steady' =>
  semitones > STEADY_BAND_SEMITONES ? 'rising' : semitones < -STEADY_BAND_SEMITONES ? 'falling' : 'steady';

const hints: Record<string, { high?: string; low?: string }> = {
  duration: { high: 'shorten the loudest layers (amp decay and release) or the patch duration', low: 'lengthen the amp decay or release of the longest layer, or the patch duration' },
  attack: { high: 'shorten amp.attack on the loudest layer; the attack is the time from onset to the peak', low: 'lengthen amp.attack on the loudest layer for a softer onset' },
  'energy-length': { high: 'shorten the amp decay or release; the energy length is the audible part, without a near-silent tail', low: 'lengthen the amp decay or sustain so the audible part lasts longer' },
  tail: { high: 'shorten the release or lower the reverb or delay send; the tail is measured to 60 dB below the peak' },
  centroid: { high: 'darker: lower the filter cutoff, or use a triangle or sine layer', low: 'brighter: raise the filter cutoff, or add a layer with upper partials' },
  flatness: { high: 'more tonal: reduce noise layers or raise their filter q', low: 'noisier: add or raise a noise layer' },
  crest: { high: 'less punchy: lengthen the attack or add sustain', low: 'punchier: shorten the attack and decay of the loudest layer' },
};

interface Measured { actual: number | string | boolean | null; unit?: string; outcome: Outcome; reason?: string; extra?: Record<string, unknown> }

function bounded(value: number, unit: string, min: number | undefined, max: number | undefined): Measured {
  return { actual: value, unit, outcome: (min === undefined || value >= min) && (max === undefined || value <= max) ? 'pass' : 'fail' };
}

/** One entry against one render's features. */
function check(e: Expectation, f: Features): Measured {
  switch (e.check) {
    case 'duration': return bounded(f.durationSec, 's', e.min, e.max);
    case 'attack': return bounded(f.attackSec, 's', e.min, e.max);
    case 'energy-length': return bounded(f.energyLengthSec, 's', e.min, e.max);
    case 'tail': return bounded(f.tailSec, 's', undefined, e.max);
    case 'centroid': return bounded(f.centroidHz, 'Hz', e.min, e.max);
    case 'flatness': return bounded(f.flatness, '0-1', e.min, e.max);
    case 'crest': return bounded(f.crestDb, 'dB', e.min, e.max);
    case 'pitch': {
      if (f.pitchStrength < e.minStrength || !(f.pitchHz > 0)) {
        return { actual: null, unit: 'Hz', outcome: 'unmeasurable', reason: `no steady pitch to measure (pitch strength ${f.pitchStrength}, needs ${e.minStrength})` };
      }
      const target = e.note !== undefined ? noteToHz(e.note) : e.hz!;
      const cents = Math.round(1200 * Math.log2(f.pitchHz / target) * 10) / 10;
      return { actual: f.pitchHz, unit: 'Hz', outcome: Math.abs(cents) <= e.toleranceCents ? 'pass' : 'fail', extra: { offCents: cents, targetHz: Math.round(target * 100) / 100 } };
    }
    case 'pitch-direction': {
      if (f.pitchStrength < PITCHED_STRENGTH) return { actual: null, outcome: 'unmeasurable', reason: `no steady pitch to follow (pitch strength ${f.pitchStrength}, needs ${PITCHED_STRENGTH})` };
      const got = direction(f.pitchDirection);
      return { actual: got, outcome: got === e.is ? 'pass' : 'fail', extra: { semitones: f.pitchDirection } };
    }
    case 'true-peak': {
      const limit = e.max !== undefined ? e.max : TRUE_PEAK_CEILING_DB + TRUE_PEAK_TOLERANCE_DB;
      return { actual: f.delivered.truePeakDb, unit: 'dBTP', outcome: f.delivered.truePeakDb <= limit ? 'pass' : 'fail' };
    }
    case 'no-clipping': return { actual: f.delivered.clippedSamples, unit: 'samples', outcome: f.delivered.clippedSamples === 0 ? 'pass' : 'fail' };
    case 'peak-limited': return { actual: f.delivered.peakLimited === true, outcome: (f.delivered.peakLimited === true) === e.is ? 'pass' : 'fail' };
  }
}

/** The `expected` side of a verdict: the entry without `check`, defaults filled in, so the verdict is readable on its own. */
function expectedOf(e: Expectation): Record<string, unknown> {
  const { check: _, ...rest } = e;
  if (e.check === 'true-peak' && e.max === undefined) return { max: TRUE_PEAK_CEILING_DB };
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
}

function hintFor(e: Expectation, m: Measured): string | undefined {
  if (m.outcome === 'unmeasurable') return e.check === 'pitch' || e.check === 'pitch-direction' ? 'give the sound a steady pitched layer (an oscillator at a fixed pitch), or drop this check for a noisy sound' : undefined;
  if (m.outcome !== 'fail') return undefined;
  const table = hints[e.check];
  if (table) {
    const a = m.actual as number;
    const min = 'min' in e ? e.min : undefined, max = 'max' in e ? e.max : undefined;
    return max !== undefined && a > max ? table.high : min !== undefined && a < min ? table.low : undefined;
  }
  switch (e.check) {
    case 'pitch': return 'change layers[].source.pitch (or the last pitchEnv target); the project scale snaps pitches, so check the render with scale.snap in mind';
    case 'pitch-direction': return 'add or reverse a pitchEnv on the pitched layer so the pitch moves the way the check says';
    case 'true-peak': return 'lower gainDb on the loudest layer; the renderer already limits, so this means the sound is spiky';
    case 'no-clipping': return 'lower gainDb on the loudest layers or drop a drive/clipper stage';
    case 'peak-limited': return e.is ? 'the sound is not peak-limited, so it reached its loudness target: remove the check or expect a quieter sound' : 'the trim stopped at the true-peak ceiling: lower the spikiest layer\'s gainDb so the sound can reach its target';
    default: return undefined;
  }
}

/**
 * Check every entry of `patch.xExpect` against the features of each of its variants. A check that fails or cannot be made on any variant
 * is reported at the first such variant; one that holds on all of them is reported from the first. `featuresByVariant[i]` is variant i.
 */
export function evaluateExpectations(patch: Patch, featuresByVariant: Features[]): ExpectationReport {
  const checks: Verdict[] = (patch.xExpect ?? []).map((e, n) => {
    const results = featuresByVariant.map(f => check(e, f));
    const bad = results.findIndex(r => r.outcome !== 'pass');
    const i = bad < 0 ? 0 : bad;
    const m = results[i];
    const hint = hintFor(e, m);
    return {
      kind: e.check, outcome: m.outcome, pointer: `/xExpect/${n}`, ...(m.unit ? { unit: m.unit } : {}),
      expected: expectedOf(e), actual: m.actual, ...(m.extra ?? {}),
      ...(featuresByVariant.length > 1 && bad >= 0 ? { variant: i } : {}),
      ...(m.reason ? { reason: m.reason } : {}), ...(hint ? { hint } : {}),
    };
  });
  return { passed: checks.every(c => c.outcome === 'pass'), checks };
}

/** The number of variants a patch's expectations are checked on: all it declares. */
export const expectationVariants = (patch: Patch): number => patch.variation?.variants ?? 1;

export interface ExpectEntry {
  /** The measured feature the check reads (the name `measure` prints). */
  reads: string;
  /** The fields of an entry, besides `check`. */
  fields: string;
  unit: string;
  summary: string;
}

/** Every kind of check, for docs/expectations.md (generated) and `capabilities`. Keyed by kind, so a new kind does not compile without an entry. */
export const EXPECT_REGISTRY: Record<ExpectKind, ExpectEntry> = {
  duration: { reads: 'durationSec', fields: 'min, max', unit: 's', summary: 'The rendered length, including the tail.' },
  attack: { reads: 'attackSec', fields: 'min, max', unit: 's', summary: 'Time from onset to the peak: a click or a swell.' },
  'energy-length': { reads: 'energyLengthSec', fields: 'min, max', unit: 's', summary: 'The audible part of the sound, without a near-silent tail.' },
  tail: { reads: 'tailSec', fields: 'max', unit: 's', summary: 'How long the sound takes to fall 60 dB below its peak (the measure the tail-ceiling rule uses).' },
  centroid: { reads: 'centroidHz', fields: 'min, max', unit: 'Hz', summary: 'The spectral centroid: bright against dark.' },
  flatness: { reads: 'flatness', fields: 'min, max', unit: '0-1', summary: 'Spectral flatness: near 0 is tonal, near 1 is noisy.' },
  crest: { reads: 'crestDb', fields: 'min, max', unit: 'dB', summary: 'Peak against average level: punch against sustain.' },
  pitch: { reads: 'pitchHz, pitchStrength', fields: 'note or hz, toleranceCents (50), minStrength (0.7)', unit: 'Hz', summary: 'The median pitch against a note or frequency, within a tolerance in cents. Unmeasurable when the pitch is not steady enough to trust.' },
  'pitch-direction': { reads: 'pitchDirection', fields: 'is: rising, falling or steady', unit: 'semitones', summary: 'Which way the pitch moves from start to end; under half a semitone is steady. Unmeasurable on an unpitched sound.' },
  'true-peak': { reads: 'delivered.truePeakDb', fields: 'max (default -1)', unit: 'dBTP', summary: 'The delivered true peak, after the loudness trim and limiter.' },
  'no-clipping': { reads: 'delivered.clippedSamples', fields: 'none', unit: 'samples', summary: 'No delivered sample is clipped.' },
  'peak-limited': { reads: 'delivered.peakLimited', fields: 'is: true or false', unit: 'yes/no', summary: 'Whether the trim stopped at the true-peak ceiling, so the sound sits below its loudness target by design.' },
};
