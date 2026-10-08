// Cheap, static checks of delivered audio (no decoding): the container headers say the right thing about length, channels and encoder.
// `beeps verify` runs them over a lock's outputs; `beeps build` runs them over what it just encoded.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, posix, relative, resolve, sep } from 'node:path';
import { BeepsError } from '../errors.ts';
import { checkLoops, MP3_ONESHOT_TOLERANCE } from '../compress.ts';
import { ExportManifestSchema, type ExportManifest } from '../export-manifest.ts';
import { parseMp3, parseOgg } from '../audio/container.ts';
import { sha256Hex } from './store.ts';
import { readLock, type Lock } from './lock.ts';

export interface StaticInfo { format: 'opus' | 'mp3' | 'wav' | 'unknown'; frames?: number; channels?: number; sampleRate?: number; encoder?: string; delay?: number; padding?: number }
export interface StaticResult { info: StaticInfo; problems: string[] }

export interface Expect { frames?: number; channels?: number; sampleRate?: number; loop?: boolean }

/** Static checks of one file: container headers, encoder id, and (given `expect.frames`) the frame count the headers imply. */
export function staticCheck(path: string, expect: Expect = {}): StaticResult {
  const ext = extname(path).toLowerCase();
  const buf = readFileSync(path);
  const problems: string[] = [];
  if (ext === '.ogg' || ext === '.opus') {
    const r = parseOgg(buf);
    if (typeof r === 'string') return { info: { format: 'unknown' }, problems: [r] };
    const frames = Number(r.granule) - r.preskip;
    if (!r.sawTags) problems.push('no OpusTags packet');
    if (!r.eos) problems.push('the last Ogg page is not marked end-of-stream (truncated file)');
    if (r.preskip <= 0) problems.push('OpusHead pre-skip is 0');
    if (expect.channels !== undefined && r.channels !== expect.channels) problems.push(`${r.channels} channels, sidecar says ${expect.channels}`);
    if (expect.sampleRate !== undefined && expect.sampleRate !== 48000) problems.push(`Ogg Opus always decodes at 48000 Hz, sidecar says ${expect.sampleRate} Hz`);
    // Decoders trim the pre-skip and stop at the final granule position, so this is the length they return.
    if (expect.frames !== undefined && frames !== expect.frames) problems.push(`Opus granule position implies ${frames} frames, sidecar says ${expect.frames}`);
    return { info: { format: 'opus', frames, channels: r.channels, sampleRate: 48000 }, problems };
  }
  if (ext === '.mp3') {
    const r = parseMp3(buf);
    if (typeof r === 'string') return { info: { format: 'unknown' }, problems: [r] };
    if (!r.tag || r.frames === undefined) {
      problems.push('no Xing/Info tag: decoders cannot trim the encoder delay, so loops gap and one-shots start late');
      return { info: { format: 'mp3', channels: r.channels, sampleRate: r.sampleRate }, problems };
    }
    // ffmpeg with +bitexact writes "Lavf lame": the same delay and padding, but Firefox then ignores the delay and decodes 1610 frames long.
    if (/^Lavf/.test(r.encoder ?? '')) problems.push(`encoder id "${r.encoder}": written with -fflags +bitexact, which Firefox does not honour the encoder delay for`);
    const frames = r.frames * r.samplesPerFrame - (r.delay ?? 0) - (r.padding ?? 0);
    if (expect.channels !== undefined && r.channels !== expect.channels) problems.push(`${r.channels} channels, sidecar says ${expect.channels}`);
    if (expect.sampleRate !== undefined && r.sampleRate !== expect.sampleRate) problems.push(`encoded at ${r.sampleRate} Hz, sidecar says ${expect.sampleRate} Hz: a browser resamples it to its context rate and the decode keeps about 50 extra frames`);
    const tolerance = expect.loop ? 1 : MP3_ONESHOT_TOLERANCE;
    if (expect.frames !== undefined && Math.abs(frames - expect.frames) > tolerance) problems.push(`MP3 tag implies ${frames} frames, sidecar says ${expect.frames}`);
    return { info: { format: 'mp3', frames, channels: r.channels, sampleRate: r.sampleRate, encoder: r.encoder, delay: r.delay, padding: r.padding }, problems };
  }
  if (ext === '.wav') {
    if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF') return { info: { format: 'unknown' }, problems: ['not a RIFF WAV'] };
    const channels = buf.readUInt16LE(22), bits = buf.readUInt16LE(34), sampleRate = buf.readUInt32LE(24), data = buf.readUInt32LE(40);
    const frames = Math.floor(data / (channels * (bits / 8)));
    if (expect.sampleRate !== undefined && sampleRate !== expect.sampleRate) problems.push(`WAV is ${sampleRate} Hz, sidecar says ${expect.sampleRate} Hz`);
    if (data + 44 > buf.length) problems.push('WAV data chunk is longer than the file');
    if (expect.frames !== undefined && frames !== expect.frames) problems.push(`WAV has ${frames} frames, sidecar says ${expect.frames}`);
    return { info: { format: 'wav', frames, channels, sampleRate }, problems };
  }
  return { info: { format: 'unknown' }, problems: [] };
}

/** What a sidecar promises about each of its files: `{ file -> frames, channels, loop }` (variants beyond the first may differ in length). */
export function sidecarExpectations(rel: string, m: ExportManifest): Map<string, Expect> {
  const dir = posix.dirname(rel), at = (f: string) => posix.join(dir, f);
  const frames = Math.round(m.durationSec * m.sampleRate);
  const out = new Map<string, Expect>();
  out.set(at(m.file), { frames, channels: m.channels, sampleRate: m.sampleRate, loop: m.loop });
  for (const l of m.layers ?? []) out.set(at(l.file), { frames, channels: m.channels, sampleRate: m.sampleRate, loop: m.loop });
  for (const v of m.variants ?? []) if (!out.has(at(v.file))) out.set(at(v.file), { channels: m.channels, sampleRate: m.sampleRate, loop: m.loop });
  return out;
}

export interface VerifyProblem { asset?: string; file?: string; problem: string }
export interface VerifyReport { ok: boolean; lock: string; out: string; assets: number; files: number; checkedStatic: number; problems: VerifyProblem[]; warnings: string[] }

/** Outputs against the lock's sha256s, the catalog's integrity, and the static container checks. `decode` adds the compress loop checks. */
export function verifyOutputs(o: { lock: string | Lock; out: string; decode?: boolean; catalog?: boolean }): VerifyReport {
  const lock = typeof o.lock === 'string' ? readLock(o.lock) : o.lock;
  if (!lock) throw new BeepsError('E_NOT_FOUND', `no lock at ${o.lock}`);
  const out = resolve(o.out);
  const problems: VerifyProblem[] = [], warnings: string[] = [];
  let files = 0, checkedStatic = 0;
  const loops: string[] = [];
  const tracked = new Set<string>();
  for (const [id, asset] of Object.entries(lock.assets)) {
    const expects = new Map<string, Expect>();
    const intact = new Set<string>();
    for (const f of asset.outputs) {
      files++;
      tracked.add(f.file);
      const full = join(out, f.file);
      if (!existsSync(full)) { problems.push({ asset: id, file: f.file, problem: 'missing' }); continue; }
      const buf = readFileSync(full);
      if (buf.length !== f.bytes) { problems.push({ asset: id, file: f.file, problem: `${buf.length} bytes, lock says ${f.bytes}` }); continue; }
      if (sha256Hex(buf) !== f.sha256) { problems.push({ asset: id, file: f.file, problem: `sha256 ${sha256Hex(buf).slice(0, 12)}, lock says ${f.sha256.slice(0, 12)}` }); continue; }
      intact.add(f.file);
      if (/\.(wav|ogg|mp3)\.json$/.test(f.file)) {
        const m = ExportManifestSchema.safeParse(safeJson(buf));
        if (!m.success) { problems.push({ asset: id, file: f.file, problem: `not a beeps/audio-asset@1 sidecar (${m.error.issues[0].message})` }); continue; }
        for (const [k, v] of sidecarExpectations(f.file, m.data)) expects.set(k, v);
        if (m.data.loop) for (const k of sidecarExpectations(f.file, m.data).keys()) loops.push(k);
        const frames = m.data.durationSec * m.data.sampleRate;
        if (Math.abs(frames - Math.round(frames)) > 1e-3) problems.push({ asset: id, file: f.file, problem: `durationSec ${m.data.durationSec} is not a whole number of frames at ${m.data.sampleRate} Hz` });
      }
    }
    for (const f of asset.outputs) {
      if (!/\.(ogg|mp3|wav)$/i.test(f.file) || !intact.has(f.file)) continue; // a file that fails its hash is reported once, not also as a bad header
      checkedStatic++;
      const r = staticCheck(join(out, f.file), expects.get(f.file));
      for (const pr of r.problems) problems.push({ asset: id, file: f.file, problem: pr });
    }
  }
  if (o.catalog !== false) catalogProblems(out, lock, tracked, problems, warnings);
  // Files in the output directory that no asset owns (a deleted recipe's leftovers, a hand-added file).
  if (existsSync(out)) for (const f of listFlat(out)) if (f !== 'index.json' && !tracked.has(f) && /\.(ogg|mp3|wav|json)$/.test(f)) warnings.push(`${f} is not in the lock`);
  if (o.decode && loops.length) {
    const present = [...new Set(loops)].filter(f => existsSync(join(out, f)) && !/\.json$/.test(f));
    // Only a length that differs from the sidecar is a failure here: the build already compared every decode with its source WAV, and a wrap
    // tick or level step measured without the source also flags music that is simply quiet at its end, so those are warnings.
    for (const r of checkLoops(present.map(f => join(out, f)))) {
      const file = relative(out, r.file).split(sep).join('/');
      for (const pr of r.problems) (/frames, sidecar says/.test(pr) ? problems.push({ file, problem: pr }) : warnings.push(`${file}: ${pr}`));
    }
  }
  return { ok: problems.length === 0, lock: typeof o.lock === 'string' ? o.lock : '(in memory)', out, assets: Object.keys(lock.assets).length, files, checkedStatic, problems, warnings };
}

const safeJson = (b: Buffer): unknown => { try { return JSON.parse(b.toString('utf8')); } catch { return undefined; } };

function listFlat(dir: string, base = dir): string[] {
  const res: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) res.push(...listFlat(join(dir, e.name), base));
    else if (e.isFile()) res.push(relative(base, join(dir, e.name)).split(sep).join('/'));
  }
  return res;
}

/** index.json must list every asset in the lock, with every file present. */
function catalogProblems(out: string, lock: Lock, tracked: Set<string>, problems: VerifyProblem[], warnings: string[]): void {
  const index = join(out, 'index.json');
  if (!existsSync(index)) { problems.push({ file: 'index.json', problem: 'catalog missing (run beeps build, or beeps bundle)' }); return; }
  let cat: { assets?: Record<string, { file: string; variants?: { file: string }[]; layers?: { file: string }[] }> };
  try { cat = JSON.parse(readFileSync(index, 'utf8')); } catch (e) { problems.push({ file: 'index.json', problem: (e as Error).message }); return; }
  const assets = cat.assets ?? {};
  const ids = new Set<string>();
  for (const [id, a] of Object.entries(assets)) {
    ids.add(id);
    for (const f of [a.file, ...(a.variants ?? []).map(v => v.file), ...(a.layers ?? []).map(l => l.file)]) {
      if (!tracked.has(f) && !existsSync(join(out, f))) problems.push({ asset: id, file: f, problem: 'listed in index.json but missing' });
    }
  }
  for (const id of Object.keys(lock.assets)) if (!ids.has(id)) problems.push({ asset: id, problem: 'in the lock but not in index.json' });
  for (const id of ids) if (!lock.assets[id]) warnings.push(`index.json lists ${id}, which is not in the lock`);
}

