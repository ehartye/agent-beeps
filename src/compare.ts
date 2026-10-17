// Candidate against reference: every number as a signed delta (candidate minus reference), and the few that matter as a sentence an
// agent can act on. The hints are indicators, not verdicts: the owner's ear decides.
import type { Analysis } from './analyze.ts';

export interface Comparison {
  reference: string;
  candidate: string;
  deltas: {
    durationSec: number;
    crestDb: number;
    centroidHz: number;
    integratedLufs: number;
    /** Energy share per band, dB, candidate minus reference. A deficit in one band is a surplus elsewhere: shares sum to 100 %. */
    spectrum: { loHz: number; hiHz: number; db: number }[];
    events: {
      count: number;
      rpmPct: number | null;
      intervalCv: number | null;
      floorDb: number | null;
      bands: { name: string; refT20Ms: number | null; candT20Ms: number | null }[];
    };
  };
  hints: string[];
}

const THRESHOLD = { floorDb: 6, rpmPct: 5, intervalCv: 0.1, crestDb: 3, bandDb: 4, decayMs: 8, decayRatio: 2, clipFraction: 0.001 };
const r1 = (v: number) => Math.round(v * 10) / 10;
const sub = (a: number | null, b: number | null) => (a === null || b === null ? null : r1(a - b));
const fmtHz = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));
const signed = (v: number, more: string, less: string) => `${r1(Math.abs(v))} dB ${v > 0 ? more : less}`;

export function compareAnalyses(ref: Analysis, cand: Analysis): Comparison {
  const spectrum = ref.spectrum.db.map((d, i) => ({ loHz: ref.spectrum.edgesHz[i], hiHz: ref.spectrum.edgesHz[i + 1], db: r1((cand.spectrum.db[i] ?? -120) - d) }));
  const re = ref.events, ce = cand.events;
  const rpmPct = re.rpm !== null && ce.rpm !== null ? r1(100 * (ce.rpm - re.rpm) / re.rpm) : null;
  const floorDb = sub(ce.floorDb, re.floorDb);
  const cvDelta = re.intervalCv !== null && ce.intervalCv !== null ? Math.round(1e3 * (ce.intervalCv - re.intervalCv)) / 1e3 : null;
  const bands = (ref.profile ?? []).map((b, i) => ({ name: b.name, refT20Ms: b.t20Ms, candT20Ms: cand.profile?.[i]?.t20Ms ?? null }));
  const deltas = {
    durationSec: r1(cand.durationSec - ref.durationSec) , crestDb: sub(cand.features.crestDb, ref.features.crestDb)!,
    centroidHz: Math.round(cand.features.centroidHz - ref.features.centroidHz), integratedLufs: sub(cand.features.integratedLufs, ref.features.integratedLufs)!,
    spectrum, events: { count: ce.count - re.count, rpmPct, intervalCv: cvDelta, floorDb, bands },
  };

  const hints: string[] = [];
  if (floorDb !== null && Math.abs(floorDb) >= THRESHOLD.floorDb && re.floorDb !== null && ce.floorDb !== null) {
    hints.push(`the gaps between events are ${signed(floorDb, 'fuller', 'emptier')} than the reference (${ce.floorDb} vs ${re.floorDb} dB under the peak): `
      + (floorDb < 0 ? 'lengthen the tail (a longer decay on the body layers) or raise the room/reverb send' : 'shorten the tails or lower the reverb send'));
  }
  if (rpmPct !== null && Math.abs(rpmPct) >= THRESHOLD.rpmPct) {
    hints.push(`repeat rate is ${Math.round(ce.rpm!)} per minute against the reference's ${Math.round(re.rpm!)} (${rpmPct > 0 ? '+' : ''}${rpmPct} %): change the step interval`);
  }
  if (cvDelta !== null && Math.abs(cvDelta) >= THRESHOLD.intervalCv) {
    hints.push(`the candidate's timing is ${cvDelta < 0 ? 'more regular' : 'looser'} than the reference (interval variation ${r1(100 * ce.intervalCv!)} % vs ${r1(100 * re.intervalCv!)} %): ${cvDelta < 0 ? 'raise humanize or add jitter' : 'tighten the timing'}`);
  }
  if (Math.abs(deltas.crestDb) >= THRESHOLD.crestDb) {
    hints.push(`crest factor is ${cand.features.crestDb} dB against ${ref.features.crestDb} dB: the candidate is ${deltas.crestDb > 0 ? 'peakier (more transient, less body and tail)' : 'flatter (more sustain, or compressed or clipped)'} than the reference`);
  }
  for (const b of spectrum) {
    if (Math.abs(b.db) >= THRESHOLD.bandDb) hints.push(`${fmtHz(b.loHz)}-${fmtHz(b.hiHz)} Hz carries ${signed(b.db, 'more', 'less')} of the energy than in the reference`);
  }
  let decayHints = 0;
  for (const b of bands) {
    if (decayHints >= 3) break;
    const span = ref.profile!.find(p => p.name === b.name)!;
    const where = `${b.name} band (${fmtHz(span.loHz)}-${fmtHz(span.hiHz)} Hz)`;
    if (b.refT20Ms !== null && b.candT20Ms !== null) {
      if (b.refT20Ms - b.candT20Ms >= THRESHOLD.decayMs && b.refT20Ms / Math.max(1, b.candT20Ms) >= THRESHOLD.decayRatio) { hints.push(`the ${where} falls 20 dB in ${b.candT20Ms} ms, the reference in ${b.refT20Ms} ms: lengthen its decay`); decayHints++; }
      else if (b.candT20Ms - b.refT20Ms >= THRESHOLD.decayMs && b.candT20Ms / Math.max(1, b.refT20Ms) >= THRESHOLD.decayRatio) { hints.push(`the ${where} falls 20 dB in ${b.candT20Ms} ms, the reference in ${b.refT20Ms} ms: shorten its decay`); decayHints++; }
    } else if (b.refT20Ms !== null && b.candT20Ms === null) { hints.push(`the ${where} never falls 20 dB inside the event window in the candidate, but does in ${b.refT20Ms} ms in the reference: shorten its tail`); decayHints++; }
    else if (b.refT20Ms === null && b.candT20Ms !== null) { hints.push(`the ${where} sustains through the event window in the reference but falls 20 dB in ${b.candT20Ms} ms in the candidate: lengthen its tail`); decayHints++; }
  }
  const refClip = ref.features.clippedSamples / Math.max(1, ref.durationSec * ref.sampleRate), candClip = cand.features.clippedSamples / Math.max(1, cand.durationSec * cand.sampleRate);
  if (refClip >= THRESHOLD.clipFraction && candClip < refClip / 10) {
    hints.push(`the reference is clipped or saturated (${r1(100 * refClip)} % of samples at full scale); the candidate is not: raise drive on the loud layers if that grit is wanted`);
  }
  return { reference: ref.file, candidate: cand.file, deltas, hints };
}
