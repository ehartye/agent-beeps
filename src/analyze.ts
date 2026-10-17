// Measure a sound that beeps did not render: a reference recording, a competitor's asset, an export from another tool.
// The same features `measure` reports for a patch, plus what a reference needs: where the sound is, whether it repeats and how,
// and the spectrum shape.
import { basename } from 'node:path';
import { decodeAudio } from './audio/decode.ts';
import { measure, type Features } from './measure/index.ts';
import { rmsEnvelope } from './measure/envelope.ts';
import { LOG_BAND_EDGES, logBands, spectrum } from './measure/spectral.ts';
import { eventProfile, findEvents, type BandProfile, type Events } from './measure/events.ts';

export interface Analysis {
  file: string;
  /** The rate analysed at: always 48 kHz, the rate beeps measures at. */
  sampleRate: number;
  /** The file's own rate; differs when it was resampled. */
  sourceSampleRate: number;
  channels: number;
  durationSec: number;
  /** Where the sound is: first and last moment within 40 dB of the peak (2 ms RMS). */
  active: { startSec: number; endSec: number };
  features: Pick<Features, 'samplePeakDb' | 'truePeakDb' | 'integratedLufs' | 'integratedReliable' | 'crestDb' | 'dcOffset' | 'clippedSamples'
    | 'centroidHz' | 'flatness' | 'sharpness' | 'roughness' | 'attackSec' | 'energyLengthSec' | 'tailSec'>;
  /** Energy per octave-ish band as dB re total, long-term (non-silent frames). `db[i]` covers `edgesHz[i]`..`edgesHz[i+1]`. */
  spectrum: { edgesHz: number[]; db: number[] };
  events: Events;
  /** The mean event per band; null when fewer than 2 events were found. */
  profile: BandProfile[] | null;
  /** How long after each onset the profile looks: 90 ms, or 90 % of the median interval when events come closer, so the next one is not read as a tail. */
  profileWindowMs: number | null;
}

const PROFILE_WINDOW_MS = 90;

const mono = (channels: Float32Array[]): Float32Array => {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
};

export function analyzeAudio(path: string): Analysis {
  const { sampleRate: sr, channels, sourceRate } = decodeAudio(path, { rate: 48000 });
  const x = mono(channels);
  const f = measure({ sampleRate: sr, authored: channels, delivered: channels });
  const env = rmsEnvelope(x, sr), top = env.reduce((a, b) => Math.max(a, b), 0);
  let a = 0, b = env.length - 1;
  while (a < b && env[a] < top * 0.01) a++;
  while (b > a && env[b] < top * 0.01) b--;
  const events = findEvents(x, sr);
  const windowMs = events.count >= 2 ? Math.min(PROFILE_WINDOW_MS, Math.floor(0.9 * (events.intervalMsMedian ?? PROFILE_WINDOW_MS))) : null;
  const r2 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    file: basename(path), sampleRate: sr, sourceSampleRate: sourceRate, channels: channels.length, durationSec: f.durationSec,
    active: { startSec: r2(a / 1000), endSec: r2((b + 1) / 1000) },
    features: {
      samplePeakDb: f.samplePeakDb, truePeakDb: f.truePeakDb, integratedLufs: f.integratedLufs, integratedReliable: f.integratedReliable,
      crestDb: f.crestDb, dcOffset: f.dcOffset, clippedSamples: f.clippedSamples, centroidHz: f.centroidHz, flatness: f.flatness,
      sharpness: f.sharpness, roughness: f.roughness, attackSec: f.attackSec, energyLengthSec: f.energyLengthSec, tailSec: f.tailSec,
    },
    spectrum: { edgesHz: LOG_BAND_EDGES, db: logBands(spectrum(x, sr)) },
    events,
    profile: windowMs === null ? null : eventProfile(x, sr, events.onsetsSec, undefined, windowMs),
    profileWindowMs: windowMs,
  };
}
