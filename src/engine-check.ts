// Cross-engine decode check: decode delivered files with OfflineAudioContext.decodeAudioData in real browser engines and compare
// the frame count and the start alignment with the source. An engine that trims or keeps codec padding differently (Firefox on a
// +bitexact MP3, an MP3 with no Xing/Info tag, Vorbis in WebM) shows here as a non-zero delta or lead, not as a surprise in a game.
import { existsSync, readFileSync } from 'node:fs';
import { readWav } from './audio/wav.ts';
import { BeepsError } from './errors.ts';
import { decodeChannels, findFfmpeg, MP3_ONESHOT_TOLERANCE, referenceFor } from './compress.ts';

export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type Engine = typeof ENGINES[number];
export const DECODE_RATES = [48000, 44100] as const;
const LEAD_WINDOW = 4096, MAX_LEAD = 3000;

export interface RateResult {
  sampleRate: number; frames: number; wantFrames: number; frameDelta: number;
  /** Frames the decode leads the source (positive: extra frames at the start; negative: frames trimmed from the start). Absent when the start has no signal to correlate. */
  lead?: number; problems: string[];
}
export interface EngineFile { file: string; results: RateResult[] }
export interface EngineReport {
  engine: Engine;
  status: 'ok' | 'unavailable' | 'no-web-audio' | 'error';
  version?: string; detail?: string; hint?: string; files: EngineFile[];
}

/** Lead of `got` against `want` in frames: argmax over k of the correlation of got[i] with want[i - k] across a window near the start. */
export function startLead(want: Float32Array, got: Float32Array, maxLead = MAX_LEAD, window = LEAD_WINDOW): number | undefined {
  const peak = want.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (peak < 1e-4) return undefined;
  let first = 0;
  while (first < want.length && Math.abs(want[first]) < peak * 0.05) first++;
  const from = Math.max(maxLead, first), to = Math.min(from + window, want.length, got.length);
  if (to - from < 256) return undefined;
  const score = new Float64Array(2 * maxLead + 1);
  let best = -Infinity;
  for (let k = -maxLead; k <= maxLead; k++) {
    let s = 0;
    for (let i = from; i < to; i++) s += got[i] * want[i - k];
    score[k + maxLead] = s;
    if (s > best) best = s;
  }
  // A steady tone correlates almost as well one period away as at the true lead; among near-ties the smallest shift is the honest answer.
  let bestK = 0, found = false;
  for (let k = -maxLead; k <= maxLead; k++) {
    if (score[k + maxLead] >= best * 0.98 && (!found || Math.abs(k) < Math.abs(bestK))) { bestK = k; found = true; }
  }
  return bestK;
}

/** The in-page decode. Runs inside the browser: no imports, no closure. */
const PAGE_DECODE = async ({ b64, rates, channels }: { b64: string; rates: number[]; channels: number }) => {
  const w = window as unknown as Record<string, any>;
  const Ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!Ctor) return { noWebAudio: true as const, results: [] as { sampleRate: number; frames: number; head?: number[]; error?: string }[] };
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const out: { sampleRate: number; frames: number; head?: number[]; error?: string }[] = [];
  for (const rate of rates) {
    try {
      const ctx = new Ctor(channels, rate, rate);
      const buf: AudioBuffer = await new Promise((res, rej) => { const p = ctx.decodeAudioData(bytes.buffer.slice(0), res, rej); if (p?.then) p.then(res, rej); });
      out.push({ sampleRate: rate, frames: buf.length, head: Array.from(buf.getChannelData(0).subarray(0, 12000)) });
    } catch (e) { out.push({ sampleRate: rate, frames: 0, error: String((e as Error)?.message ?? e) }); }
  }
  return { noWebAudio: false as const, results: out };
};

const installHint = (engine: Engine) => `install it with: npx playwright install ${engine}   (or: node scripts/setup.js --browsers ${engine})`;

/** Decode each file in each engine. Engines that cannot launch report `unavailable` with an install hint; a WebKit without Web Audio reports `no-web-audio`. */
export async function engineCheck(files: string[], engines: Engine[], opts: { source?: string } = {}): Promise<EngineReport[]> {
  const ffmpeg = findFfmpeg();
  const refs = files.map(file => {
    const { sidecar, sourceWav } = referenceFor(file, opts);
    const wav = sourceWav ? readWav(readFileSync(sourceWav)) : undefined;
    const channels = wav?.channels.length ?? sidecar?.channels ?? 2;
    const baseRate = wav?.sampleRate ?? sidecar?.sampleRate ?? 48000;
    const frames = wav ? wav.channels[0].length : sidecar ? Math.round(sidecar.durationSec * baseRate) : decodeChannels(ffmpeg, file, channels, baseRate)[0].length;
    const loop = sidecar?.loop ?? true;
    const tolerance = /\.mp3$/i.test(file) && !loop ? MP3_ONESHOT_TOLERANCE : 0;
    // The reference at each decode rate: the source resampled by ffmpeg (a .wav source) or the delivered file as ffmpeg decodes it.
    const at = (rate: number) => decodeChannels(ffmpeg, sourceWav ?? file, channels, rate)[0];
    return { file, channels, baseRate, frames, tolerance, at, bytes: readFileSync(file) };
  });
  const playwright = await import('playwright').catch(() => undefined);
  const reports: EngineReport[] = [];
  for (const engine of engines) {
    const type = playwright?.[engine];
    let browser: import('playwright').Browser | undefined;
    if (!type || !existsSync(type.executablePath())) { reports.push({ engine, status: 'unavailable', detail: `the Playwright ${engine} browser is not installed`, hint: installHint(engine), files: [] }); continue; }
    try { browser = await type.launch(); } catch (e) { reports.push({ engine, status: 'unavailable', detail: `could not launch ${engine}: ${String((e as Error).message).split('\n')[0]}`, hint: installHint(engine), files: [] }); continue; }
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      const report: EngineReport = { engine, status: 'ok', version: browser.version(), files: [] };
      for (const ref of refs) {
        const r = await page.evaluate(PAGE_DECODE, { b64: ref.bytes.toString('base64'), rates: [...DECODE_RATES], channels: ref.channels });
        if (r.noWebAudio) { report.status = 'no-web-audio'; report.detail = `${engine} ${report.version} has no OfflineAudioContext, so nothing was decoded (this is not a pass)`; report.files = []; break; }
        const results: RateResult[] = r.results.map(d => {
          const want = Math.round(ref.frames * d.sampleRate / ref.baseRate);
          if (d.error) return { sampleRate: d.sampleRate, frames: 0, wantFrames: want, frameDelta: 0, problems: [`${engine} could not decode at ${d.sampleRate} Hz: ${d.error}`] };
          const problems: string[] = [];
          const delta = d.frames - want;
          // A sample-rate conversion rounds, so a context at another rate may differ by one frame; at the file's own rate the count is exact.
          const tol = ref.tolerance + (d.sampleRate === ref.baseRate ? 0 : 1);
          if (Math.abs(delta) > tol) problems.push(`${engine} decoded ${d.frames} frames at ${d.sampleRate} Hz, want ${want}: ${delta > 0 ? 'keeps' : 'trims'} ${Math.abs(delta)} frames`);
          const lead = d.head ? startLead(ref.at(d.sampleRate), Float32Array.from(d.head)) : undefined;
          if (lead !== undefined && lead !== 0) problems.push(`${engine} output leads the source by ${lead} frames at ${d.sampleRate} Hz`);
          return { sampleRate: d.sampleRate, frames: d.frames, wantFrames: want, frameDelta: delta, ...(lead !== undefined ? { lead } : {}), problems };
        });
        report.files.push({ file: ref.file, results });
      }
      reports.push(report);
    } catch (e) {
      reports.push({ engine, status: 'error', detail: String((e as Error).message).split('\n')[0], files: [] });
    } finally { await browser.close(); }
  }
  return reports;
}

export function parseEngines(list: string): Engine[] {
  const names = list.split(',').map(s => s.trim()).filter(Boolean);
  const bad = names.filter(n => !(ENGINES as readonly string[]).includes(n));
  if (bad.length || !names.length) throw new BeepsError('E_USAGE', `--engines takes ${ENGINES.join(', ')} separated by commas, not ${bad.join(',') || list}`);
  return [...new Set(names)] as Engine[];
}
