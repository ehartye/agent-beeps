import { integrated, momentaryMax, samplePeakDb, shortTermMax, truePeakDb } from './loudness.ts';
import { attackTime, clippedSamples, crestDb, dcOffset, energyLength, tailLength } from './envelope.ts';
import { centroid, flatness, logBands, peakCentroid, spectrum } from './spectral.ts';
import { fluctuation, roughness, sharpness } from './psycho.ts';
import { pitchTrack } from './pitch.ts';

export interface PcmTaps { sampleRate: number; authored: Float32Array[]; delivered: Float32Array[] }

export interface Features {
  durationSec: number;
  samplePeakDb: number; truePeakDb: number; dcOffset: number; clippedSamples: number;
  momentaryMaxLufs: number; shortTermMaxLufs: number; integratedLufs: number; integratedReliable: boolean;
  attackSec: number; energyLengthSec: number; tailSec: number; crestDb: number;
  centroidHz: number; centroidPeakHz: number; flatness: number; bands: number[];
  sharpness: number; roughness: number; fluctuation: number;
  pitchHz: number; pitchStrength: number; pitchDirection: number; voicedFraction: number;
  /** peakLimited: the loudness trim was capped so the true peak stays under the ceiling (spiky sounds sit below target by design). */
  delivered: { samplePeakDb: number; truePeakDb: number; momentaryMaxLufs: number; clippedSamples: number; peakLimited?: boolean };
}

const mono = (channels: Float32Array[]): Float32Array => {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
};

const r = (x: number, digits = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** digits) / 10 ** digits : x);

/** Every feature is measured on the authored (pre-trim, pre-limiter) tap; peaks are also reported delivered. */
export function measure(pcm: PcmTaps): Features {
  const sr = pcm.sampleRate;
  const x = mono(pcm.authored);
  const spec = spectrum(x, sr);
  const pitch = pitchTrack(x, sr);
  const int = integrated(pcm.authored, sr);
  return {
    durationSec: r(x.length / sr),
    samplePeakDb: r(samplePeakDb(pcm.authored), 2),
    truePeakDb: r(truePeakDb(pcm.authored, sr), 2),
    dcOffset: r(dcOffset(x), 6),
    clippedSamples: clippedSamples(pcm.authored),
    momentaryMaxLufs: r(momentaryMax(pcm.authored, sr), 2),
    shortTermMaxLufs: r(shortTermMax(pcm.authored, sr), 2),
    integratedLufs: r(int.lufs, 2),
    integratedReliable: int.reliable,
    attackSec: r(attackTime(x, sr)),
    energyLengthSec: r(energyLength(x, sr)),
    tailSec: r(tailLength(x, sr)),
    crestDb: r(crestDb(x), 2),
    centroidHz: r(centroid(spec), 1),
    centroidPeakHz: r(peakCentroid(spec), 1),
    flatness: r(flatness(spec)),
    bands: logBands(spec),
    sharpness: r(sharpness(x, sr)),
    roughness: r(roughness(x, sr)),
    fluctuation: r(fluctuation(x, sr)),
    pitchHz: r(pitch.medianHz, 2),
    pitchStrength: r(pitch.strength),
    pitchDirection: r(pitch.directionSemitones, 2),
    voicedFraction: r(pitch.voicedFraction),
    delivered: {
      samplePeakDb: r(samplePeakDb(pcm.delivered), 2),
      truePeakDb: r(truePeakDb(pcm.delivered, sr), 2),
      momentaryMaxLufs: r(momentaryMax(pcm.delivered, sr), 2),
      clippedSamples: clippedSamples(pcm.delivered),
    },
  };
}

/** The perceptual axes the taste model learns over. Times and frequencies on log scales. */
export const FEATURE_NAMES = [
  'energyLength', 'attack', 'brightness', 'sharpness', 'roughness', 'fluctuation',
  'noisiness', 'pitchStrength', 'pitchDirection', 'punch', 'register',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

export function featureVector(f: Features): number[] {
  const pitched = f.pitchStrength >= 0.7 && f.pitchHz > 0;
  return [
    Math.log10(Math.max(0.005, f.energyLengthSec)),
    Math.log10(Math.max(0.0005, f.attackSec)),
    Math.log2(Math.max(50, f.centroidHz) / 1000),
    f.sharpness,
    f.roughness,
    f.fluctuation,
    f.flatness,
    f.pitchStrength,
    Math.max(-24, Math.min(24, f.pitchDirection)) / 12,
    f.crestDb / 10,
    pitched ? Math.log2(f.pitchHz / 440) : 0,
  ];
}
