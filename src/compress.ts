// Compressed delivery: re-encode an exported bundle (WAV + sidecars) as Ogg Opus, verify that every encoded file decodes to the
// exact frame count and lines up with its source, and check that a loop still wraps cleanly. A shipped WAV costs 10-15 MB per
// music track; Opus at 48-64 kbps costs under 1 MB and measures as gapless in Chromium and Firefox (decodeAudioData trims the
// pre-skip and the end by the Ogg granule position), where AAC from ffmpeg's native encoder does not.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { seamMetrics, seamWarning, type SeamMetrics } from './measure/seam.ts';
import { BeepsError } from './errors.ts';
import { readWav } from './audio/wav.ts';
import { bundleDir } from './bundle.ts';
import { encoderLead } from './audio/container.ts';
import { ExportManifestSchema, type ExportManifest } from './export-manifest.ts';

/** Bitrates by role. Music is sparse synth and pads, ambience is noise (the costly kind for a codec), sfx is short. */
export const DEFAULT_KBPS = { music: 56, ambience: 48, sfx: 72 } as const;

/** ffmpeg: $BEEPS_FFMPEG, the optional ffmpeg-static dependency, or `ffmpeg` on the PATH. */
export function findFfmpeg(): string {
  const env = process.env.BEEPS_FFMPEG;
  if (env) {
    if (!existsSync(env)) throw new BeepsError('E_NOT_FOUND', `BEEPS_FFMPEG points at ${env}, which does not exist`);
    return env;
  }
  try {
    const p = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    if (p && existsSync(p)) return p;
  } catch { /* optional dependency not installed */ }
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'ffmpeg';
  throw new BeepsError('E_NOT_FOUND', 'no ffmpeg with libopus found', { hint: 'install the optional ffmpeg-static dependency (npm i ffmpeg-static), put ffmpeg on the PATH, or set BEEPS_FFMPEG to its path' });
}

function run(ffmpeg: string, args: string[]) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new BeepsError('E_RENDER', `ffmpeg ${args.slice(0, 4).join(' ')} failed: ${r.stderr?.toString().trim() || r.error?.message || r.status}`);
  return r.stdout;
}

export type CompressFormat = 'opus' | 'mp3';
/** Delivery formats: Ogg Opus is the small default; MP3 is the fallback for browsers with no Ogg Opus decoder (Safari before it landed). LAME writes its gapless header, so loops keep their length. */
export const FORMATS: Record<CompressFormat, { ext: string; codec: 'opus' | 'mp3'; container: 'ogg' | 'mp3'; defaultKbps: Record<'music' | 'ambience' | 'sfx', number> }> = {
  opus: { ext: 'ogg', codec: 'opus', container: 'ogg', defaultKbps: DEFAULT_KBPS },
  mp3: { ext: 'mp3', codec: 'mp3', container: 'mp3', defaultKbps: { music: 80, ambience: 64, sfx: 96 } },
};

/** One MPEG frame (1152 samples): a short one-shot MP3 may decode up to this many frames longer (a silent tail from the final frame's padding). Loops stay exact. */
export const MP3_ONESHOT_TOLERANCE = 1152;

/**
 * The encoder arguments between input and output. `beeps build` hashes them, so changing a flag here re-encodes every asset.
 * MP3: CBR with the Xing/LAME info frame (write_xing, on by default): the header carries encoder delay and padding so decoders trim them.
 * No `+bitexact`: it drops that delay from the header, and Firefox then decodes 1610 frames long (measured; Chromium reads it from the frames and is unaffected).
 * Opus: -vbr on keeps quiet passages cheap; -application audio is the music mode; bitexact keeps the bytes reproducible.
 */
export function encoderArgs(codec: CompressFormat, kbps: number): string[] {
  return codec === 'mp3'
    ? ['-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-write_xing', '1', '-id3v2_version', '0', '-ar', '48000']
    : ['-map_metadata', '-1', '-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'on', '-application', 'audio', '-ar', '48000', '-fflags', '+bitexact', '-flags:a', '+bitexact'];
}

export function encodeMp3(ffmpeg: string, wav: string, out: string, kbps: number): void {
  mkdirSync(dirname(out), { recursive: true });
  run(ffmpeg, ['-y', '-i', wav, ...encoderArgs('mp3', kbps), out]);
}

export function encodeOpus(ffmpeg: string, wav: string, out: string, kbps: number): void {
  mkdirSync(dirname(out), { recursive: true });
  run(ffmpeg, ['-y', '-i', wav, ...encoderArgs('opus', kbps), out]);
}

/** The ffmpeg build that encodes: its version line and libavcodec version (libopus and LAME are statically linked, so the build identifies them). */
export function ffmpegFingerprint(ffmpeg: string): { ffmpeg: string; libavcodec: string } {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' });
  if (r.status !== 0) throw new BeepsError('E_NOT_FOUND', `cannot run ${ffmpeg} -version`);
  const lines = r.stdout.split(/\r?\n/);
  const version = lines[0].match(/^ffmpeg version (\S+)/)?.[1] ?? lines[0].trim();
  const avcodec = lines.find(l => l.startsWith('libavcodec'))?.replace(/\s+/g, '').replace(/\/.*/, '') ?? 'unknown';
  return { ffmpeg: version, libavcodec: avcodec };
}

/** Decode any container ffmpeg reads to float32 channels at the file's own rate. */
export function decodeChannels(ffmpeg: string, file: string, channels: number, sampleRate: number): Float32Array[] {
  const raw = run(ffmpeg, ['-i', file, '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', String(channels), '-ar', String(sampleRate), '-']);
  const frames = Math.floor(raw.length / (4 * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0, o = 0; i < frames; i++) for (let c = 0; c < channels; c++, o += 4) out[c][i] = raw.readFloatLE(o);
  return out;
}

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const rms = (a: Float32Array, from: number, to: number) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, to - from)); };

/**
 * How a loop wraps. A click at the wrap is broadband energy in the first difference of the signal, so the report compares the
 * energy of the 5 ms window straddling the wrap with the 95th-percentile 5 ms window of the rest of the file:
 * `seamExcessDb` near 0 is a seamless wrap (noise and busy music included), +10 or more is an audible tick.
 * `levelStepDb` is the RMS of the first 250 ms against the last 250 ms (a fade to silence or a different texture shows here).
 */
export function wrapReport(channels: Float32Array[], sampleRate: number) {
  const n = channels[0]?.length ?? 0;
  const half = Math.max(2, Math.round(sampleRate * 0.0025)), win = half * 2;
  const bins = Math.floor((n - 1) / win);
  const energy: number[] = [];
  let seam = 0;
  for (const ch of channels) {
    for (let b = 0; b < bins; b++) {
      let e = 0;
      for (let i = b * win + 1; i < (b + 1) * win + 1; i++) { const d = ch[i] - ch[i - 1]; e += d * d; }
      energy[b] = (energy[b] ?? 0) + e;
    }
    // The wrap: the last `half` steps into the end, the step from the last sample to the first, and `half` steps after it.
    const at = (i: number) => ch[(i + n) % n];
    for (let k = -half; k < half; k++) { const d = at(k) - at(k - 1); seam += d * d; }
  }
  const sorted = energy.slice().sort((x, y) => x - y);
  const reference = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 1e-12;
  const winLen = Math.min(n >> 2, Math.round(sampleRate * 0.25));
  let endRms = 0, startRms = 0, jump = 0;
  for (const ch of channels) { endRms += rms(ch, n - winLen, n); startRms += rms(ch, 0, winLen); jump = Math.max(jump, Math.abs(ch[0] - ch[n - 1])); }
  return { seamExcessDb: db(Math.sqrt(seam)) - db(Math.sqrt(reference)), jump, levelStepDb: db(startRms / channels.length) - db(endRms / channels.length) };
}

/** Pearson correlation of the 20 ms RMS envelopes: noise beds are re-synthesised by the codec, so only their shape in time lines up. */
export function envelopeCorrelation(want: Float32Array[], got: Float32Array[], sampleRate: number): number {
  const win = Math.round(sampleRate * 0.02), n = Math.min(want[0].length, got[0].length), bins = Math.floor(n / win);
  const env = (ch: Float32Array[]) => Array.from({ length: bins }, (_, b) => { let s = 0; for (const c of ch) for (let i = b * win; i < (b + 1) * win; i++) s += c[i] * c[i]; return s / (win * ch.length); });
  const a = env(want), b = env(got);
  const ma = a.reduce((x, y) => x + y, 0) / bins, mb = b.reduce((x, y) => x + y, 0) / bins;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < bins; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(Math.max(saa * sbb, 1e-30));
}

/** Signal to error of `got` against `want`, in dB. A mis-aligned or truncated decode scores near 0 dB; a good lossy one 15 dB or more. */
export function alignmentSnrDb(want: Float32Array[], got: Float32Array[]): number {
  let sig = 0, err = 0;
  const n = Math.min(want[0].length, got[0].length);
  for (let c = 0; c < want.length; c++) for (let i = 0; i < n; i++) { const d = want[c][i] - got[c][i]; sig += want[c][i] ** 2; err += d * d; }
  return 10 * Math.log10(Math.max(sig, 1e-20) / Math.max(err, 1e-20));
}

export interface FileCheck {
  file: string; kbps: number; bytes: number; sourceBytes: number;
  frames: number; wantFrames: number; frameDelta: number; snrDb: number; envelopeCorrelation: number;
  /** Loops only. */
  wrap?: { seamExcessDb: number; sourceSeamExcessDb: number; levelStepDb: number; sourceLevelStepDb: number; seam: SeamMetrics; sourceSeam: SeamMetrics };
  /** Not failures: a loop may start on a transient by design. */
  warnings?: string[];
  problems: string[];
}

export interface CompressOptions {
  kbps?: Partial<Record<'music' | 'ambience' | 'sfx' | 'mix', number>>;
  /** Fail (E_RENDER) instead of reporting when a file does not verify. Default true. */
  strict?: boolean;
  /** Output codec and container. Default 'opus' (Ogg Opus). */
  format?: CompressFormat;
}

/** A frame count that differs, a decode that does not line up with the source, or a loop that now clicks. */
export function verify(source: { channels: Float32Array[]; sampleRate: number }, decoded: Float32Array[], loop: boolean, role: ExportManifest['role'], tolerance = 0): Omit<FileCheck, 'file' | 'kbps' | 'bytes' | 'sourceBytes'> {
  const want = source.channels[0].length, frames = decoded[0].length;
  const snr = alignmentSnrDb(source.channels, decoded);
  const problems: string[] = [];
  if (Math.abs(frames - want) > tolerance) problems.push(`decoded ${frames} frames, source has ${want}: the codec added or trimmed ${frames - want}`);
  // Tonal material (music) keeps its waveform through the codec: a one-frame (960 sample) slip drops the match far below 6 dB.
  // Noise beds and sfx are re-synthesised, so only their loudness over time can line up.
  const envelope = envelopeCorrelation(source.channels, decoded, source.sampleRate);
  if (role === 'music' ? snr < 8 : envelope < 0.8) problems.push(role === 'music' ? `decode lines up with the source at only ${snr.toFixed(1)} dB` : `decoded loudness over time follows the source at only ${envelope.toFixed(2)}`);
  let wrap: FileCheck['wrap'];
  const warnings: string[] = [];
  if (loop) {
    const a = wrapReport(source.channels, source.sampleRate), b = wrapReport(decoded, source.sampleRate);
    wrap = { seamExcessDb: round(b.seamExcessDb), sourceSeamExcessDb: round(a.seamExcessDb), levelStepDb: round(b.levelStepDb), sourceLevelStepDb: round(a.levelStepDb), seam: seamMetrics(decoded), sourceSeam: seamMetrics(source.channels) };
    const warn = seamWarning(wrap.sourceSeam, wrap.seam);
    if (warn) warnings.push(warn);
    if (b.seamExcessDb > 6 && b.seamExcessDb > a.seamExcessDb + 3) problems.push(`the loop wrap ticks after encoding: ${b.seamExcessDb.toFixed(1)} dB over the loudest of the rest (source ${a.seamExcessDb.toFixed(1)} dB)`);
  }
  return { frames, wantFrames: want, frameDelta: frames - want, snrDb: round(snr), envelopeCorrelation: round(envelope), ...(wrap ? { wrap } : {}), ...(warnings.length ? { warnings } : {}), problems };
}
const round = (x: number) => Math.round(x * 100) / 100;

function sidecarsOf(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.wav.json')).map(e => e.name).sort();
}

/**
 * Re-encode every asset of a flat bundle directory (WAVs and `*.wav.json` sidecars) into `outDir` as Ogg Opus, with `*.ogg.json`
 * sidecars and an index.json. Every encoded file is decoded again and checked against its source.
 */
export function compressBundle(srcDir: string, outDir: string, opts: CompressOptions = {}) {
  const ffmpeg = findFfmpeg();
  const src = resolve(srcDir), out = resolve(outDir);
  if (src === out) throw new BeepsError('E_USAGE', 'the output directory must differ from the source directory');
  mkdirSync(out, { recursive: true });
  const fmt = FORMATS[opts.format ?? 'opus'];
  const kbpsFor = (role: ExportManifest['role']) => opts.kbps?.[role] ?? fmt.defaultKbps[role];
  const checks: FileCheck[] = [];
  const assets: { id: string; role: string; bytes: number }[] = [];
  const sidecars = sidecarsOf(src);
  if (!sidecars.length) throw new BeepsError('E_NOT_FOUND', `${src}: no *.wav.json sidecars (export with --manifest first)`);
  for (const name of sidecars) {
    const m = ExportManifestSchema.parse(JSON.parse(readFileSync(join(src, name), 'utf8')));
    const kbps = kbpsFor(m.role);
    // An adaptive asset's own mix file is not what the player loads (it plays the layers): a preview, so it can be small.
    const mixKbps = m.layers ? Math.min(kbps, opts.kbps?.mix ?? kbps) : kbps;
    const encode = (file: string): string => {
      const wav = join(src, file);
      const ogg = file.replace(/\.wav$/i, `.${fmt.ext}`);
      const rate = file === m.file && m.layers ? mixKbps : kbps;
      (fmt.codec === 'mp3' ? encodeMp3 : encodeOpus)(ffmpeg, wav, join(out, ogg), rate);
      const source = readWav(readFileSync(wav));
      const decoded = decodeChannels(ffmpeg, join(out, ogg), source.channels.length, source.sampleRate);
      const bytes = statSync(join(out, ogg)).size;
      // Variants of an sfx are one-shots; layers and the mix of a loop are loops.
      checks.push({ file: ogg, kbps: rate, bytes, sourceBytes: statSync(wav).size, ...verify(source, decoded, m.loop, m.role, fmt.codec === 'mp3' && !m.loop ? MP3_ONESHOT_TOLERANCE : 0) });
      return ogg;
    };
    const files = new Set<string>([m.file, ...(m.variants ?? []).map(v => v.file), ...(m.layers ?? []).map(l => l.file)]);
    const renamed = new Map([...files].map(f => [f, encode(f)]));
    // The decoder's lead-in as the file's own headers state it (Opus pre-skip, MP3 encoder delay): a player can check or compensate for it.
    const lead = encoderLead(join(out, renamed.get(m.file)!));
    const next: ExportManifest = {
      ...m, file: renamed.get(m.file)!,
      ...(m.variants ? { variants: m.variants.map(v => ({ ...v, file: renamed.get(v.file)! })) } : {}),
      ...(m.layers ? { layers: m.layers.map(l => ({ ...l, file: renamed.get(l.file)! })) } : {}),
      encoding: { codec: fmt.codec, container: fmt.container, kbps, ...(lead !== undefined ? { lead } : {}) } as ExportManifest['encoding'],
    };
    writeFileSync(join(out, `${basename(next.file)}.json`), JSON.stringify(ExportManifestSchema.parse(next), null, 2) + '\n');
    assets.push({ id: m.id, role: m.role, bytes: [...renamed.values()].reduce((s, f) => s + statSync(join(out, f)).size, 0) });
  }
  bundleDir(out);
  const total = checks.reduce((s, c) => s + c.bytes, 0), sourceTotal = checks.reduce((s, c) => s + c.sourceBytes, 0);
  const problems = checks.filter(c => c.problems.length).map(c => ({ file: c.file, problems: c.problems }));
  const warnings = checks.filter(c => c.warnings?.length).map(c => ({ file: c.file, warnings: c.warnings! }));
  return { out, ffmpeg, files: checks.length, bytes: total, sourceBytes: sourceTotal, assets, checks, problems, warnings };
}

/** The sidecar of a delivered file and its source WAV: named by `source` (a file, or a directory holding <stem>.wav), else <stem>.wav beside it. */
export function referenceFor(file: string, opts: { source?: string } = {}): { sidecar?: ExportManifest; sourceWav?: string } {
  const sidecar = existsSync(`${file}.json`) ? ExportManifestSchema.parse(JSON.parse(readFileSync(`${file}.json`, 'utf8'))) : undefined;
  const name = basename(file).replace(/\.[^.]+$/, '');
  const candidates = [opts.source && join(opts.source, `${name}.wav`), opts.source, join(dirname(file), `${name}.wav`)].filter((p): p is string => !!p);
  return { sidecar, sourceWav: candidates.find(p => /\.wav$/i.test(p) && existsSync(p)) };
}

/** Check already-encoded files (any container ffmpeg decodes) against their sidecars: frame count and loop wrap. */
export function checkLoops(paths: string[], { source }: { source?: string } = {}) {
  const ffmpeg = findFfmpeg();
  return paths.map(p => {
    const side = existsSync(`${p}.json`) ? ExportManifestSchema.parse(JSON.parse(readFileSync(`${p}.json`, 'utf8'))) : undefined;
    const channels = side?.channels ?? 2, sampleRate = side?.sampleRate ?? 48000;
    const decoded = decodeChannels(ffmpeg, p, channels, sampleRate);
    const frames = decoded[0].length;
    const want = side ? Math.round(side.durationSec * sampleRate) : undefined;
    const w = wrapReport(decoded, sampleRate);
    const problems: string[] = [];
    if (want !== undefined && Math.abs(frames - want) > 1) problems.push(`${frames} frames, sidecar says ${want}`);
    if (w.seamExcessDb > 6) problems.push(`the wrap ticks: ${w.seamExcessDb.toFixed(1)} dB over the loudest 5 ms of the rest`);
    if (Math.abs(w.levelStepDb) > 3) problems.push(`the loop ends ${w.levelStepDb > 0 ? 'quieter' : 'louder'} than it starts by ${Math.abs(w.levelStepDb).toFixed(1)} dB`);
    const seam = seamMetrics(decoded), warnings: string[] = [];
    const isLoop = side ? side.loop : true;
    // With the source WAV beside it (or named by `source`), the delivered seam is compared with the source's.
    const { sourceWav } = referenceFor(p, { source });
    let sourceSeam: SeamMetrics | undefined;
    if (sourceWav && isLoop) {
      sourceSeam = seamMetrics(readWav(readFileSync(sourceWav)).channels);
      const warn = seamWarning(sourceSeam, seam);
      if (warn) warnings.push(warn);
    }
    return { file: p, frames, ...(want !== undefined ? { wantFrames: want } : {}), seamExcessDb: round(w.seamExcessDb), levelStepDb: round(w.levelStepDb), ...(isLoop ? { seam } : {}), ...(sourceSeam ? { sourceSeam } : {}), ...(warnings.length ? { warnings } : {}), problems };
  });
}
