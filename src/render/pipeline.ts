// Render → measure → loudness trim → re-render delivered → cache WAV, features and look image.
// Patches carry no loudness literal: the trim is computed from the authored tap's measured
// max momentary loudness so every sound meets the project target ("a gain literal is not a loudness").
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderKey } from '../hash.ts';
import { writeWav } from '../audio/wav.ts';
import { measure, type Features } from '../measure/index.ts';
import type { Patch } from '../schema/patch.ts';
import type { Project } from '../schema/project.ts';
import type { RenderHost } from './host.ts';

/** Loudness offsets (LU re project target) by family: quiet UI, fuller impacts. */
export const FAMILY_OFFSETS: Record<string, number> = {
  'ui-hover': -8, 'ui-click': -6, blip: -6, confirm: -3, no: -3, pickup: -1, coin: -1,
  explosion: 2, hit: 1, alarm: 0,
};

export interface Rendered {
  key: string;
  patch: Patch;
  seed: number;
  variant: number;
  trimDb: number;
  features: Features;
  dir: string;
  wavPath: string;
  lookPath: string;
}

export type RenderOutcome = ({ ok: true } & Rendered) | { ok: false; patchName: string; error: string };

export interface PipelineItem { patch: Patch; seed?: number; variant?: number }

/** Delivered true-peak target for the trim (0.5 dB under the -1 dBTP rule, for inter-sample margin). */
export const PEAK_CEILING_DB = -1.7;

/** Bump when trimming or measurement changes, so cached renders are redone. */
export const PIPELINE_VERSION = 2;

/** The cache key of one patch render, computable without a browser (`beeps build` hashes it). */
export const patchRenderKey = (patch: Patch, project: Project, seed: number, variant: number): string =>
  renderKey(patch, { seed, variant, scale: project.scale, target: targetFor(patch, project), pipeline: PIPELINE_VERSION });

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export const targetFor = (patch: Patch, project: Project) => project.targetLoudness + (FAMILY_OFFSETS[patch.family] ?? 0);

export async function renderAndMeasure(host: RenderHost, items: PipelineItem[], { project, rendersDir }: { project: Project; rendersDir: string }): Promise<RenderOutcome[]> {
  const scale = project.scale;
  const keyed = items.map(i => {
    const seed = i.seed ?? 1, variant = i.variant ?? 0;
    const key = patchRenderKey(i.patch, project, seed, variant);
    return { ...i, seed, variant, key, dir: join(rendersDir, key) };
  });
  const out: RenderOutcome[] = new Array(items.length);
  const misses: number[] = [];
  keyed.forEach((k, i) => {
    const meta = join(k.dir, 'meta.json');
    if (existsSync(meta) && existsSync(join(k.dir, 'delivered.wav')) && existsSync(join(k.dir, 'look.png'))) {
      const m = JSON.parse(readFileSync(meta, 'utf8'));
      out[i] = { ok: true, key: k.key, patch: k.patch, seed: k.seed, variant: k.variant, trimDb: m.trimDb, features: m.features, dir: k.dir, wavPath: join(k.dir, 'delivered.wav'), lookPath: join(k.dir, 'look.png') };
    } else misses.push(i);
  });
  if (!misses.length) return out;

  // Pass 1: authored tap (trim does not touch it) → features and trim.
  const pass1 = await host.render(misses.map(i => ({ patch: keyed[i].patch, opts: { seed: keyed[i].seed, variant: keyed[i].variant, scale } })));
  const trims: number[] = [];
  const limited: boolean[] = [];
  const features: (Features | undefined)[] = [];
  pass1.forEach((r, j) => {
    const i = misses[j];
    if (!r.ok) { out[i] = { ok: false, patchName: keyed[i].patch.name, error: r.error }; return; }
    const f = measure(r);
    // Below BS.1770's -70 LUFS absolute gate there is nothing to level-match.
    if (!(f.momentaryMaxLufs > -70)) { out[i] = { ok: false, patchName: keyed[i].patch.name, error: `patch rendered near-silence (${f.momentaryMaxLufs} LUFS)` }; return; }
    features[j] = f;
    // Loudness first, but never push the true peak into the clipper: spiky sounds (hits, clicks)
    // would otherwise be flattened. Peak-limited sounds sit below target by design.
    const loud = targetFor(keyed[i].patch, project) - f.momentaryMaxLufs;
    const ceiling = PEAK_CEILING_DB - f.truePeakDb;
    trims[j] = Math.round(clamp(Math.min(loud, ceiling), -36, 24) * 100) / 100;
    limited[j] = ceiling < loud;
  });

  // Pass 2: delivered tap with the trim applied through the real limiter.
  const live = misses.map((i, j) => ({ i, j })).filter(({ j }) => features[j]);
  const pass2 = await host.render(live.map(({ i, j }) => ({ patch: keyed[i].patch, opts: { seed: keyed[i].seed, variant: keyed[i].variant, scale, trimDb: trims[j] } })));
  const looks: { i: number; mono: Float32Array; f: Features }[] = [];
  pass2.forEach((r, n) => {
    const { i, j } = live[n];
    if (!r.ok) { out[i] = { ok: false, patchName: keyed[i].patch.name, error: r.error }; return; }
    const d = measure({ sampleRate: r.sampleRate, authored: r.delivered, delivered: r.delivered });
    const f: Features = { ...features[j]!, delivered: { samplePeakDb: d.samplePeakDb, truePeakDb: d.truePeakDb, momentaryMaxLufs: d.momentaryMaxLufs, clippedSamples: d.clippedSamples, ...(limited[j] ? { peakLimited: true } : {}) } };
    const k = keyed[i];
    mkdirSync(k.dir, { recursive: true });
    writeFileSync(join(k.dir, 'delivered.wav'), writeWav(r.delivered, r.sampleRate));
    writeFileSync(join(k.dir, 'patch.json'), JSON.stringify(k.patch, null, 2));
    const mono = new Float32Array(r.authored[0].length);
    for (const ch of r.authored) for (let s = 0; s < mono.length; s++) mono[s] += ch[s] / r.authored.length;
    looks.push({ i, mono, f });
    out[i] = { ok: true, key: k.key, patch: k.patch, seed: k.seed, variant: k.variant, trimDb: trims[j], features: f, dir: k.dir, wavPath: join(k.dir, 'delivered.wav'), lookPath: join(k.dir, 'look.png') };
  });
  if (looks.length) {
    const pngs = await host.looks(looks.map(l => ({ mono: l.mono, sampleRate: 48000, features: l.f, label: keyed[l.i].patch.name })));
    pngs.forEach((png, n) => writeFileSync(join(keyed[looks[n].i].dir, 'look.png'), png));
  }
  // meta.json last: its presence (with the WAV and look) is what makes a cache hit.
  for (const l of looks) {
    const o = out[l.i];
    if (o.ok) writeFileSync(join(o.dir, 'meta.json'), JSON.stringify({ patchName: o.patch.name, seed: o.seed, variant: o.variant, trimDb: o.trimDb, features: o.features }, null, 2));
  }
  return out;
}

/** A contact sheet of already-rendered items, labelled 1..N (for sets and auditions). */
export async function contactSheet(host: RenderHost, rendered: Rendered[], labels: string[], outPath: string): Promise<string> {
  const { readWav } = await import('../audio/wav.ts');
  const items = rendered.map((r, n) => {
    const { channels, sampleRate } = readWav(readFileSync(r.wavPath));
    const mono = new Float32Array(channels[0].length);
    for (const ch of channels) for (let s = 0; s < mono.length; s++) mono[s] += ch[s] / channels.length;
    return { mono, sampleRate, features: r.features, label: labels[n] };
  });
  const [png] = await host.looks(items, true);
  writeFileSync(outPath, png);
  return outPath;
}
