// Crossfade planning for a score of songs: which loops can hand over to which without a clash, judged from what the songs
// write rather than by ear. Per song: tempo, loop length, an estimated key and a pitch-class profile (time-weighted, from the
// written notes). Per pair: the tempo relation, whether the loops can be phase-locked, and how much of their harmony agrees.
import { compileSong } from '../runtime/engine/sequence.js';
import type { Song } from './schema/song.ts';

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
// Krumhansl-Kessler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const cosine = (a: number[], b: number[]) => {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return ab / Math.sqrt(Math.max(aa * bb, 1e-30));
};
const correlate = (a: number[], b: number[]) => {
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  return cosine(a.map(x => x - ma), b.map(x => x - mb));
};
const rotate = (p: number[], by: number) => p.map((_, i) => p[(i - by + 12) % 12]);

export interface SongKey { key: string; tonic: string; mode: 'major' | 'minor'; confidence: number }

/** The best-fitting major or minor key for a pitch-class profile (Krumhansl-Schmuckler). Dorian and aeolian read as minor, mixolydian and lydian as major. */
export function estimateKey(profile: number[]): SongKey {
  let best: SongKey = { key: 'C major', tonic: 'C', mode: 'major', confidence: -2 };
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, prof] of [['major', MAJOR], ['minor', MINOR]] as const) {
      const r = correlate(profile, rotate(prof, tonic));
      if (r > best.confidence) best = { key: `${NAMES[tonic]} ${mode}`, tonic: NAMES[tonic], mode, confidence: Math.round(r * 100) / 100 };
    }
  }
  return best;
}

export interface SongPlan {
  name: string; bpm: number; meter: number; bars: number; barSec: number; loopSec: number; key: SongKey;
  /** The five strongest pitch classes (share of written note time), e.g. D 0.31. */
  pitchClasses: { pc: string; share: number }[];
}

export function planSong(song: Song): SongPlan & { profile: number[] } {
  const c = compileSong(song);
  const profile = new Array<number>(12).fill(0);
  const spb = 60 / song.bpm;
  for (const e of c.events) if (e.midi !== null && e.midi !== undefined) profile[((e.midi % 12) + 12) % 12] += Math.min(e.dur ?? spb * 0.5, spb * 8) * (e.vel ?? 0.7);
  const total = profile.reduce((a, b) => a + b, 0) || 1;
  const barSec = spb * song.meter;
  return {
    name: song.name, bpm: song.bpm, meter: song.meter, bars: Math.round(c.length / barSec), barSec: Math.round(barSec * 1000) / 1000, loopSec: Math.round(c.length * 1000) / 1000,
    key: estimateKey(profile), profile,
    pitchClasses: profile.map((v, i) => ({ pc: NAMES[i], share: Math.round((v / total) * 100) / 100 })).sort((a, b) => b.share - a.share).slice(0, 5),
  };
}

const RATIOS: [number, number][] = [[1, 1], [2, 1], [3, 2], [4, 3], [5, 4], [3, 1], [4, 1]];
/** The simplest ratio a/b (a >= b) within 1.5% of the tempo ratio, or null. */
export function tempoRelation(x: number, y: number): { ratio: string; exact: boolean } | null {
  const hi = Math.max(x, y), lo = Math.min(x, y), r = hi / lo;
  for (const [a, b] of RATIOS) if (Math.abs(r - a / b) / (a / b) < 0.015) return { ratio: `${a}:${b}`, exact: Math.abs(r - a / b) < 1e-9 };
  return null;
}

export interface PairPlan {
  a: string; b: string; tempo: string; harmony: number; keys: string;
  /** Loops with the same bpm whose lengths divide each other: `music(id, { sync: true })` lands them in step. */
  phaseLock: boolean;
  /** Tempos relate by a simple ratio, so a bar-quantized crossfade lands on a shared pulse. */
  barAligned: boolean;
  verdict: 'sync' | 'bar' | 'pulse' | 'clash-risk';
  notes: string[];
}

/** harmony: cosine similarity of the two pitch-class profiles (1 = same notes at the same weights; under 0.55 is a likely clash). */
export function pairPlan(a: ReturnType<typeof planSong>, b: ReturnType<typeof planSong>): PairPlan {
  const harmony = Math.round(cosine(a.profile, b.profile) * 100) / 100;
  const rel = tempoRelation(a.bpm, b.bpm);
  const sameBpm = a.bpm === b.bpm;
  const hi = Math.max(a.loopSec, b.loopSec), lo = Math.min(a.loopSec, b.loopSec);
  const divides = Math.abs(hi / lo - Math.round(hi / lo)) < 1e-3 * (hi / lo);
  const phaseLock = sameBpm && divides;
  const notes: string[] = [];
  if (!rel) notes.push(`tempos ${a.bpm} and ${b.bpm} share no simple ratio: a crossfade has two unrelated pulses`);
  if (sameBpm && !divides) notes.push(`loop lengths ${a.loopSec}s and ${b.loopSec}s do not divide: sync starts mid-phrase (bars still line up)`);
  if (harmony < 0.55) notes.push(`pitch classes agree at ${harmony}: expect a clash through the crossfade unless it is short`);
  const verdict: PairPlan['verdict'] = harmony < 0.55 ? 'clash-risk' : phaseLock ? 'sync' : sameBpm ? 'bar' : rel ? 'pulse' : 'clash-risk';
  return { a: a.name, b: b.name, tempo: rel ? `${rel.ratio}${rel.exact ? '' : ' (about)'}` : `${a.bpm}/${b.bpm}`, harmony, keys: `${a.key.key} / ${b.key.key}`, phaseLock, barAligned: !!rel, verdict, notes };
}

export function planScore(songs: Song[]) {
  const plans = songs.map(planSong);
  const pairs: PairPlan[] = [];
  for (let i = 0; i < plans.length; i++) for (let j = i + 1; j < plans.length; j++) pairs.push(pairPlan(plans[i], plans[j]));
  return { songs: plans.map(({ profile: _p, ...rest }) => rest), pairs };
}
