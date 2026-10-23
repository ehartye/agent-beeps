// The golden kit: a blessed render of each kit sound, and a check that says whether today's render is the same sound. A hash can only say
// "different"; this says identical (same samples), equivalent (different samples inside every tolerance) or different (with what moved and
// by how much), so a change to the engine, the toolchain or a patch is judged by its effect and not by the fact that bytes changed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BeepsError } from './errors.ts';
import type { Features } from './measure/index.ts';

export const GOLDEN_DIR = 'golden';

export const TiersSchema = z.strictObject({
  /** Absolute seconds: the rendered length and the audible length. */
  durationSec: z.number().positive().default(0.01),
  tailSec: z.number().positive().default(0.05),
  attackSec: z.number().positive().default(0.002),
  /** Relative change in the spectral centroid, percent. */
  centroidPct: z.number().positive().default(5),
  /** Root-mean-square difference over the eight log bands, dB. */
  bandRmsDb: z.number().positive().default(1.5),
  /** Absolute change in the loudest moment's loudness, LU. */
  loudnessLu: z.number().positive().default(0.3),
  /** Change of a steady pitch, cents. */
  pitchCents: z.number().positive().default(20),
});
export type Tiers = z.output<typeof TiersSchema>;

const Measured = z.strictObject({
  durationSec: z.number(), energyLengthSec: z.number(), tailSec: z.number(), attackSec: z.number(), centroidHz: z.number(),
  pitchHz: z.number(), pitchStrength: z.number(), loudnessLufs: z.number(), truePeakDb: z.number(),
});
export type Measured = z.output<typeof Measured>;

export const GoldenSchema = z.strictObject({
  schema: z.literal('beeps/golden@1'),
  name: z.string(),
  /** The render seed it was blessed at: a check renders at this seed, so a re-seeded noise layer is not mistaken for a change. */
  seed: z.number().int(),
  /** The render cache key at bless time (informative: a different key means the patch, project or toolchain input changed). */
  key: z.string(),
  wavSha256: z.string(),
  measured: Measured,
  bands: z.array(z.number()),
  /** Overrides of the default tolerances for this sound (a noisy sound can take a looser band tolerance). */
  tiers: TiersSchema.partial().optional(),
});
export type Golden = z.output<typeof GoldenSchema>;

export const goldenFile = (projectDir: string, name: string) => join(projectDir, GOLDEN_DIR, `${name}.json`);

export const sha256Bytes = (b: Buffer | Uint8Array): string => createHash('sha256').update(b).digest('hex');

export const measuredOf = (f: Features): Measured => ({
  durationSec: f.durationSec, energyLengthSec: f.energyLengthSec, tailSec: f.tailSec, attackSec: f.attackSec, centroidHz: f.centroidHz,
  pitchHz: f.pitchHz, pitchStrength: f.pitchStrength, loudnessLufs: f.delivered.momentaryMaxLufs, truePeakDb: f.delivered.truePeakDb,
});

/** The golden record of one render. `previous` keeps a sound's own tolerance overrides when it is blessed again. */
export function goldenOf(name: string, seed: number, key: string, wav: Buffer, f: Features, previous?: Golden): Golden {
  return { schema: 'beeps/golden@1', name, seed, key, wavSha256: sha256Bytes(wav), measured: measuredOf(f), bands: f.bands, ...(previous?.tiers ? { tiers: previous.tiers } : {}) };
}

export function writeGolden(projectDir: string, g: Golden): string {
  const file = goldenFile(projectDir, g.name);
  mkdirSync(join(projectDir, GOLDEN_DIR), { recursive: true });
  writeFileSync(file, JSON.stringify(g, null, 2) + '\n');
  return file;
}

export function readGolden(projectDir: string, name: string): Golden | undefined {
  const file = goldenFile(projectDir, name);
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new BeepsError('E_SCHEMA', `${file} is not valid JSON: ${(e as Error).message}`); }
  const r = GoldenSchema.safeParse(raw);
  if (!r.success) throw new BeepsError('E_SCHEMA', `${file}: ${r.error.issues[0].message}`, { pointer: '/' + r.error.issues[0].path.join('/') });
  return r.data;
}

export type GoldenVerdict = 'identical' | 'equivalent' | 'different';

export interface Moved { feature: string; was: number; now: number; change: number; limit: number; unit: string }
export interface GoldenResult {
  verdict: GoldenVerdict;
  /** Root-mean-square difference of the log-band energies, dB: how far apart the timbre is. 0 for identical samples. */
  timbreDistanceDb: number;
  /** Every measure that moved past its tolerance (empty unless different). */
  moved: Moved[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Compare today's render with the blessed one. */
export function judgeGolden(g: Golden, now: { wavSha256: string; features: Features }): GoldenResult {
  const bandDist = (() => {
    const a = g.bands, b = now.features.bands;
    if (a.length !== b.length || !a.length) return Infinity;
    return Math.sqrt(a.reduce((s, v, i) => s + (b[i] - v) ** 2, 0) / a.length);
  })();
  if (now.wavSha256 === g.wavSha256) return { verdict: 'identical', timbreDistanceDb: 0, moved: [] };
  const t = TiersSchema.parse(g.tiers ?? {});
  const m = measuredOf(now.features), was = g.measured;
  const moved: Moved[] = [];
  const check = (feature: string, a: number, b: number, change: number, limit: number, unit: string) => {
    if (Math.abs(change) > limit) moved.push({ feature, was: a, now: b, change: r2(change), limit, unit });
  };
  check('durationSec', was.durationSec, m.durationSec, m.durationSec - was.durationSec, t.durationSec, 's');
  check('energyLengthSec', was.energyLengthSec, m.energyLengthSec, m.energyLengthSec - was.energyLengthSec, t.durationSec, 's');
  check('tailSec', was.tailSec, m.tailSec, m.tailSec - was.tailSec, t.tailSec, 's');
  check('attackSec', was.attackSec, m.attackSec, m.attackSec - was.attackSec, t.attackSec, 's');
  if (was.centroidHz > 0) check('centroidHz', was.centroidHz, m.centroidHz, (100 * (m.centroidHz - was.centroidHz)) / was.centroidHz, t.centroidPct, '%');
  check('loudnessLufs', was.loudnessLufs, m.loudnessLufs, m.loudnessLufs - was.loudnessLufs, t.loudnessLu, 'LU');
  const steady = (x: Measured) => x.pitchStrength >= 0.7 && x.pitchHz > 0;
  if (steady(was) !== steady(m)) moved.push({ feature: 'pitched', was: Number(steady(was)), now: Number(steady(m)), change: Number(steady(m)) - Number(steady(was)), limit: 0, unit: 'yes/no' });
  else if (steady(was)) check('pitchHz', was.pitchHz, m.pitchHz, 1200 * Math.log2(m.pitchHz / was.pitchHz), t.pitchCents, 'cents');
  if (bandDist > t.bandRmsDb) moved.push({ feature: 'timbre', was: 0, now: r2(bandDist), change: r2(bandDist), limit: t.bandRmsDb, unit: 'dB rms over the log bands' });
  return { verdict: moved.length ? 'different' : 'equivalent', timbreDistanceDb: Number.isFinite(bandDist) ? r2(bandDist) : -1, moved };
}
