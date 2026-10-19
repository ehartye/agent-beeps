// The runtime harness: render a cue through the baked path and through the runtime voice, in the same browser with the same seed,
// and say how far apart the two are. `beeps runtime parity|perf|live|look` and `beeps verify --parity` are faces of this.
import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RUNTIME_DIR, serveStatic, openRenderHost } from '../render/host.ts';
import { applyParams } from '../../runtime/engine/params.js';
import type { Cue } from './cue.ts';
import type { Scale } from '../schema/project.ts';
import { diffTap, featureDelta, featuresOf, type FeatureKey, type Pcm, type TapDiff } from './compare.ts';
import { selectSampleWavs, type EncodedSampleWavs } from '../samples/transport.ts';
import { sampleId } from '../samples/store.ts';
import { readSampleWav } from '../../runtime/engine/sample-wav.js';
import { writeWav } from '../audio/wav.ts';

export type Kind = 'baked' | 'runtime';
export type EngineName = 'chromium' | 'firefox' | 'webkit';

/** The honest cross-browser tolerance, measured (docs/runtime.md): features, never samples. */
export const CROSS_BROWSER = { loudnessLu: 1, centroidHz: 30 } as const;

export interface ParityCase {
  label: string;
  params: Record<string, number>;
  variant: number;
  seed: number;
  /** 'none' renders without scale snapping, so a live (continuous) input is compared with a bake that does not quantise it. */
  scale?: 'cue' | 'none';
  /** Send the patch's reverb to a shared bus of this preset instead of a convolver of its own. Not bit-exact by construction. */
  reverbBus?: string;
  /**
   * What the runtime voice owes the bake. exact: every sample of both taps. near: a live input moved, so the voice applies it as a
   * detune and the bake as a different frequency (rounding, below -75 dBFS). bus: the wet signal is summed elsewhere (same sound,
   * correlation above 0.9999 and loudness within 0.1 LU). by-design: a live pitch input with the scale snapping, which the bake
   * quantises and a continuous detune cannot; reported, never failed.
   */
  expect?: 'exact' | 'near' | 'bus' | 'by-design';
}

export interface Spec {
  kind: Kind; patch: Cue['patch']; params: Record<string, number>; seed: number; variant: number; scale?: Scale; trimDb: number;
  reverbBus?: string; live?: { at: number; input: string; value: number; tau: number }[];
  sampleWavs?: EncodedSampleWavs;
}

export interface CaseReport {
  cue: string;
  case: string;
  /** The runtime voice against the bake, same browser. */
  runtime: { delivered: TapDiff; authored: TapDiff; features: Record<FeatureKey, number> };
  /** Negative control: changed recorded PCM for sample cues, otherwise seed + 1. */
  control: TapDiff;
  controlKind: 'sample-content' | 'seed';
  /** SHA-256 prefix of the delivered samples over fresh-page repeats of each kind: how many distinct renders came out. */
  distinct: Record<Kind, number>;
  /** The bake rendered by the production render host equals the bake rendered by this harness (chromium only). */
  hostEqualsHarness?: boolean;
  expect: NonNullable<ParityCase['expect']>;
  /** Did the case meet its expectation (see ParityCase.expect). A by-design case always passes. */
  pass: boolean;
}

const b64 = (s: string): Float32Array => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const unpack = (r: any): Pcm => ({ sampleRate: r.sampleRate, delivered: r.delivered.map(b64), authored: r.authored.map(b64) });
const hash = (p: Pcm) => { const h = createHash('sha256'); for (const c of [...p.delivered, ...p.authored]) h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength)); return h.digest('hex').slice(0, 12); };

/** Stage a folder the harness page can be served from: a copy of the engine and the page. */
export function stage(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-runtime-harness-'));
  cpSync(join(RUNTIME_DIR, 'engine'), join(dir, 'engine'), { recursive: true });
  copyFileSync(join(import.meta.dirname, 'harness-page.js'), join(dir, 'harness-page.js'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>beeps runtime harness</title><script type="module" src="./harness-page.js"></script>');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const defaultCases = (cue: Cue): ParityCase[] => {
  const patch = cue.patch;
  const inputs = Object.entries(patch.xRuntime?.inputs ?? {});
  const live = new Set((patch.xRuntime?.bind ?? []).filter(b => b.live).map(b => b.input));
  const pitchLive = (patch.xRuntime?.bind ?? []).some(b => b.live && (b.target === '/out/transpose' || (Array.isArray(b.target) ? b.target : [b.target]).includes('/out/transpose')));
  const at = (pick: 'min' | 'max') => Object.fromEntries(inputs.map(([k, i]) => [k, i[pick]]));
  const moved = (p: Record<string, number>) => Object.entries(p).some(([k, v]) => live.has(k) && v !== patch.xRuntime!.inputs[k].default);
  const expectFor = (p: Record<string, number>, snap: boolean): ParityCase['expect'] => (!moved(p) ? 'exact' : pitchLive && snap && cue.scale?.snap ? 'by-design' : 'near');
  const seed = cue.seed;
  return [
    { label: 'defaults', params: {}, variant: 0, seed, expect: 'exact' },
    { label: 'variant 2, other seed', params: {}, variant: 2, seed: seed + 13, expect: 'exact' },
    ...(inputs.length ? [
      { label: 'inputs at min', params: at('min'), variant: 0, seed, expect: expectFor(at('min'), true) },
      { label: 'inputs at max', params: at('max'), variant: 1, seed, expect: expectFor(at('max'), true) },
      { label: 'inputs at max, no scale snap', params: at('max'), variant: 0, seed, scale: 'none' as const, expect: expectFor(at('max'), false) },
    ] : []),
    ...(patch.fx?.reverb ? [{ label: 'shared reverb bus', params: {}, variant: 0, seed, reverbBus: patch.fx.reverb.preset, expect: 'bus' as const }] : []),
  ];
};

/** Judge one case against what its expectation promises. */
export function judge(expect: NonNullable<ParityCase['expect']>, r: { delivered: TapDiff; authored: TapDiff; features: Record<FeatureKey, number> }): boolean {
  if (expect === 'by-design') return true;
  if (expect === 'exact') return r.delivered.bitExact && r.authored.bitExact;
  if (expect === 'near') return r.delivered.maxAbsDb < -75 && r.delivered.correlation > 0.99999;
  return r.delivered.correlation > 0.9999 && Math.abs(r.features.momentaryMaxLufs) <= 0.1;
}

export async function launch(engine: EngineName, args: string[] = []) {
  const pw = await import('playwright');
  return pw[engine].launch({ timeout: 60000, ...(args.length ? { args } : {}) });
}

type Browser = Awaited<ReturnType<typeof launch>>;

/** A served harness and a function that renders a spec in a fresh page of a browser. */
async function session(browser: Browser, url: string) {
  const open = async () => {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await pg.goto(`${url}/index.html`);
    await pg.waitForFunction(() => (window as any).ready === true, null, { timeout: 30000 });
    return { pg, ctx };
  };
  const run = async (spec: Spec): Promise<Pcm> => {
    const { pg, ctx } = await open();
    try { return unpack(await pg.evaluate((s: Spec) => (window as any).run(s), spec)); } finally { await ctx.close(); }
  };
  return { open, run };
}

const specOf = (cue: Cue, c: ParityCase, kind: Kind, scale: Scale | undefined, sampleWavs?: EncodedSampleWavs): Spec => ({
  kind, patch: cue.patch, params: c.params, seed: c.seed, variant: c.variant,
  sampleWavs: selectSampleWavs(cue.patch, sampleWavs),
  scale: c.scale === 'none' ? (scale ? { ...scale, snap: false } : undefined) : scale, trimDb: cue.trimDb, ...(c.reverbBus ? { reverbBus: c.reverbBus } : {}),
});

export interface EngineReport {
  engine: EngineName;
  version: string;
  /** webkit on Windows has no OfflineAudioContext: reported, never passed. */
  status?: 'ok' | 'no-web-audio' | 'unavailable';
  cases: CaseReport[];
  /** Cross-browser: this engine's bake and runtime against chromium's bake, same case (absent for chromium itself). */
  vsChromium?: { cue: string; case: string; baked: TapDiff; runtime: TapDiff; runtimeFeatures: Record<FeatureKey, number> }[];
}

export interface SampleTransportOptions { sampleWavs?: EncodedSampleWavs }
export interface ParityOptions extends SampleTransportOptions { cues: Cue[]; engines: EngineName[]; runs: number; cases?: (cue: Cue) => ParityCase[] }

/** Change actual content and its identity together, never smuggle changed bytes under the original hash. */
function negativeControl(spec: Spec): { spec: Spec; kind: CaseReport['controlKind'] } {
  const entries = Object.entries(spec.sampleWavs ?? {});
  if (!entries.length) return { spec: { ...spec, seed: spec.seed + 1 }, kind: 'seed' };
  const replacements = new Map<string, string>(), wavs: Record<string, string> = {};
  for (const [id, encoded] of entries) {
    const decoded = readSampleWav(Buffer.from(encoded, 'base64'));
    const nonzero = decoded.channels.some(c => c.some(x => x !== 0));
    const channels = decoded.channels.map(c => Float32Array.from(c, (x, i) => nonzero ? -x : 0.125 * Math.cos(i * 2 * Math.PI * 220 / 48000)));
    const wav = writeWav(channels, 48000, { bits: 32 }), changed = sampleId(wav);
    replacements.set(id, changed); wavs[changed] = wav.toString('base64');
  }
  const patch = structuredClone(spec.patch);
  for (const l of patch.layers) if (l.source.type === 'sample') l.source.asset = replacements.get(l.source.asset)!;
  return { spec: { ...spec, patch, sampleWavs: wavs }, kind: 'sample-content' };
}

export async function runParity(o: ParityOptions): Promise<EngineReport[]> {
  const st = stage();
  const site = await serveStatic(st.dir);
  const reports: EngineReport[] = [];
  /** chromium's bake per cue and case, for the cross-browser deltas. */
  const chromiumBaked = new Map<string, Pcm>();
  try {
    for (const engine of o.engines) {
      let browser: Browser;
      try { browser = await launch(engine); } catch (e) { reports.push({ engine, version: `unavailable: ${(e as Error).message.split('\n')[0]}`, status: 'unavailable', cases: [] }); continue; }
      const { open, run } = await session(browser, site.url);
      {
        const { pg, ctx } = await open();
        const has = await pg.evaluate(() => typeof (window as any).OfflineAudioContext === 'function');
        await ctx.close();
        if (!has) { reports.push({ engine, version: browser.version(), status: 'no-web-audio', cases: [] }); await browser.close(); continue; }
      }
      const report: EngineReport = { engine, version: browser.version(), status: 'ok', cases: [], ...(engine !== 'chromium' ? { vsChromium: [] } : {}) };
      const host = engine === 'chromium' ? await openRenderHost() : undefined;
      try {
        for (const cue of o.cues) {
          for (const c of (o.cases ?? defaultCases)(cue)) {
            // A bus case compares against a bake with the voice's own reverb: same sound, different summing, so not bit-exact.
            const baked: Pcm[] = [], runtime: Pcm[] = [];
            for (let i = 0; i < o.runs; i++) { baked.push(await run(specOf(cue, c, 'baked', cue.scale, o.sampleWavs))); runtime.push(await run(specOf(cue, c, 'runtime', cue.scale, o.sampleWavs))); }
            const key = `${cue.id}|${c.label}`;
            if (engine === 'chromium') chromiumBaked.set(key, baked[0]);
            const refF = featuresOf(baked[0]);
            const negative = negativeControl(specOf(cue, { ...c, reverbBus: undefined }, 'runtime', cue.scale, o.sampleWavs));
            const control = diffTap(baked[0].delivered, (await run(negative.spec)).delivered);
            let hostEqualsHarness: boolean | undefined;
            if (host) {
              const { patch: applied, trimDeltaDb } = applyParams(cue.patch, c.params, true);
              const scale = specOf(cue, c, 'baked', cue.scale, o.sampleWavs).scale;
              const [r] = await host.render([{ patch: applied, opts: { seed: c.seed, variant: c.variant, scale, trimDb: cue.trimDb + trimDeltaDb, sampleWavs: selectSampleWavs(applied, o.sampleWavs) } }]);
              hostEqualsHarness = r.ok && diffTap(r.delivered, baked[0].delivered).bitExact && diffTap(r.authored, baked[0].authored).bitExact;
            }
            const rt = { delivered: diffTap(baked[0].delivered, runtime[0].delivered), authored: diffTap(baked[0].authored, runtime[0].authored), features: featureDelta(refF, featuresOf(runtime[0])) };
            const expect = c.expect ?? 'exact';
            report.cases.push({
              cue: cue.id, case: c.label, control, controlKind: negative.kind, expect, pass: judge(expect, rt),
              runtime: rt,
              distinct: { baked: new Set(baked.map(hash)).size, runtime: new Set(runtime.map(hash)).size },
              ...(hostEqualsHarness === undefined ? {} : { hostEqualsHarness }),
            });
            if (engine !== 'chromium') {
              const ref = chromiumBaked.get(key);
              if (ref) report.vsChromium!.push({ cue: cue.id, case: c.label, baked: diffTap(ref.delivered, baked[0].delivered), runtime: diffTap(ref.delivered, runtime[0].delivered), runtimeFeatures: featureDelta(featuresOf(ref), featuresOf(runtime[0])) });
            }
          }
        }
      } finally { await host?.close(); await browser.close(); }
      reports.push(report);
    }
  } finally { site.server.close(); st.cleanup(); }
  return reports;
}

/** The cross-browser rule: loudness and spectral centroid of the runtime voice within tolerance of Chromium's bake. */
export function crossBrowserProblems(delta: { momentaryMaxLufs: number; centroidHz: number }): string[] {
  const problems: string[] = [];
  if (Math.abs(delta.momentaryMaxLufs) > CROSS_BROWSER.loudnessLu) problems.push(`loudness differs from chromium's bake by ${delta.momentaryMaxLufs} LU (tolerance ${CROSS_BROWSER.loudnessLu})`);
  if (Math.abs(delta.centroidHz) > CROSS_BROWSER.centroidHz) problems.push(`spectral centroid differs from chromium's bake by ${delta.centroidHz} Hz (tolerance ${CROSS_BROWSER.centroidHz})`);
  return problems;
}

/** What `beeps verify --parity` says about one cue in one browser. */
export interface ParityVerdict {
  cue: string;
  engine: EngineName;
  /** 'exact': same browser build and every sample of both taps identical. 'features': another browser, compared by loudness and centroid. */
  mode: 'exact' | 'features';
  ok: boolean;
  problems: string[];
  measured: { maxAbsDb?: number; loudnessLu?: number; centroidHz?: number };
}

export interface ParityCheck {
  engines: { engine: EngineName; version: string; status: 'ok' | 'no-web-audio' | 'unavailable' }[];
  verdicts: ParityVerdict[];
}

/**
 * The gate behind `beeps verify --parity`: each cue at its input defaults, baked against runtime. In chromium (the browser the
 * build bakes with) the two must be bit-exact. In another browser the runtime voice is compared with chromium's bake by features:
 * loudness within CROSS_BROWSER.loudnessLu and spectral centroid within CROSS_BROWSER.centroidHz. An engine that cannot render
 * offline audio is reported, never passed.
 */
export async function checkParity(cues: Cue[], engines: EngineName[], { sampleWavs }: SampleTransportOptions = {}): Promise<ParityCheck> {
  const st = stage();
  const site = await serveStatic(st.dir);
  const out: ParityCheck = { engines: [], verdicts: [] };
  const chromiumBaked = new Map<string, Pcm>();
  try {
    for (const engine of [...new Set<EngineName>(['chromium', ...engines])]) {
      let browser: Browser;
      try { browser = await launch(engine); } catch (e) { out.engines.push({ engine, version: `unavailable: ${(e as Error).message.split('\n')[0]}`, status: 'unavailable' }); continue; }
      try {
        const { open, run } = await session(browser, site.url);
        const probe = await open();
        const has = await probe.pg.evaluate(() => typeof (window as any).OfflineAudioContext === 'function');
        await probe.ctx.close();
        if (!has) { out.engines.push({ engine, version: browser.version(), status: 'no-web-audio' }); continue; }
        out.engines.push({ engine, version: browser.version(), status: 'ok' });
        for (const cue of cues) {
          const c: ParityCase = { label: 'defaults', params: {}, variant: 0, seed: cue.seed };
          const baked = await run(specOf(cue, c, 'baked', cue.scale, sampleWavs));
          const runtime = await run(specOf(cue, c, 'runtime', cue.scale, sampleWavs));
          if (engine === 'chromium') chromiumBaked.set(cue.id, baked);
          const problems: string[] = [];
          if (engine === 'chromium') {
            const d = diffTap(baked.delivered, runtime.delivered), a = diffTap(baked.authored, runtime.authored);
            if (!d.bitExact) problems.push(`delivered tap differs from the bake in ${d.differing} of ${d.samples} samples (max ${d.maxAbsDb.toFixed(1)} dBFS)`);
            if (!a.bitExact) problems.push(`authored tap differs from the bake in ${a.differing} of ${a.samples} samples (max ${a.maxAbsDb.toFixed(1)} dBFS)`);
            out.verdicts.push({ cue: cue.id, engine, mode: 'exact', ok: problems.length === 0, problems, measured: { maxAbsDb: d.maxAbsDb } });
          } else {
            const ref = chromiumBaked.get(cue.id);
            if (!ref) { out.verdicts.push({ cue: cue.id, engine, mode: 'features', ok: false, problems: ['no chromium bake to compare with'], measured: {} }); continue; }
            const delta = featureDelta(featuresOf(ref), featuresOf(runtime));
            problems.push(...crossBrowserProblems(delta));
            out.verdicts.push({ cue: cue.id, engine, mode: 'features', ok: problems.length === 0, problems, measured: { loudnessLu: delta.momentaryMaxLufs, centroidHz: delta.centroidHz } });
          }
        }
      } finally { await browser.close(); }
    }
  } finally { site.server.close(); st.cleanup(); }
  return out;
}

/** Time voice builds (cold and warm) and count the nodes and buffers they create, in one browser. */
export interface PerfOptions extends SampleTransportOptions { memory?: boolean; n?: number; engine?: EngineName; realtime?: boolean; varySeed?: boolean; bus?: boolean; dispose?: boolean; noiseLimit?: number | 'inf' }
export interface PerfRow { cue: string;
  /** AudioBuffers still alive in the page after a garbage collection, counted through the DevTools protocol (Runtime.queryObjects): the direct leak instrument. Only with `memory`. */
  liveAudioBuffers?: { count: number; mb: number };
  /** AudioNodes still alive after a garbage collection (the context's own nodes included): a graph that is not freed shows here. Only with `memory`. */
  liveAudioNodes?: number; ctxState?: string; firstMs: number; medianMs: number; p95Ms: number; maxMs: number; warmCounts: Record<string, number>; n: number; noiseCache: { entries: number; bytes: number; limit: number } }

export async function runPerf(cues: Cue[], { n = 60, engine = 'chromium', realtime = false, varySeed = false, bus = false, dispose = false, noiseLimit, memory = false, sampleWavs }: PerfOptions = {}): Promise<PerfRow[]> {
  const st = stage();
  const site = await serveStatic(st.dir);
  const browser = await launch(engine, [...(realtime ? ['--autoplay-policy=no-user-gesture-required'] : []), ...(memory ? ['--js-flags=--expose-gc'] : [])]);
  const out: PerfRow[] = [];
  try {
    for (const cue of cues) {
      // a fresh page per measurement: caches are per context, but module-level state should start cold too
      const ctx = await browser.newContext();
      const pg = await ctx.newPage();
      await pg.goto(`${site.url}/index.html`);
      await pg.waitForFunction(() => (window as any).ready === true);
      const spec = { patch: cue.patch, params: {}, seed: cue.seed, variant: 0, scale: cue.scale, trimDb: cue.trimDb, sampleWavs: selectSampleWavs(cue.patch, sampleWavs), realtime, varySeed, dispose, noiseLimit, keepOpen: memory, ...(bus && cue.patch.fx?.reverb ? { bus: cue.patch.fx.reverb.preset } : {}) };
      const settle = async () => { await pg.evaluate(async () => { (window as any).gc?.(); await new Promise(r => setTimeout(r, 300)); (window as any).gc?.(); }); };
      if (memory) await settle();
      const r = await pg.evaluate(([s, count]) => (window as any).perf(s, count), [spec, n] as const) as Omit<PerfRow, 'cue'>;
      if (memory) await settle();
      let live: PerfRow['liveAudioBuffers'], nodes: number | undefined;
      if (memory && engine === 'chromium') {
        const cdp = await ctx.newCDPSession(pg);
        const proto = await cdp.send('Runtime.evaluate', { expression: 'AudioBuffer.prototype' });
        const found = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId! });
        const tally = await cdp.send('Runtime.callFunctionOn', { objectId: found.objects.objectId!, returnByValue: true, functionDeclaration: 'function () { let count = 0, bytes = 0; for (const b of this) { count++; bytes += b.length * b.numberOfChannels * 4; } return { count, bytes }; }' });
        live = { count: tally.result.value.count, mb: Math.round(tally.result.value.bytes / 1048576) };
        const nproto = await cdp.send('Runtime.evaluate', { expression: 'AudioNode.prototype' });
        const nfound = await cdp.send('Runtime.queryObjects', { prototypeObjectId: nproto.result.objectId! });
        const ncount = await cdp.send('Runtime.callFunctionOn', { objectId: nfound.objects.objectId!, returnByValue: true, functionDeclaration: 'function () { return this.length; }' });
        nodes = ncount.result.value;
      }
      out.push({ cue: cue.id, ...r, ...(memory ? (live ? { liveAudioBuffers: live, liveAudioNodes: nodes } : {}) : {}) });
      await ctx.close();
    }
  } finally { await browser.close(); site.server.close(); st.cleanup(); }
  return out;
}

export interface LiveReport {
  cue: string;
  /** The input moved at `at` seconds, to `value`, with time constant `tau`. */
  move: { input: string; from: number; to: number; at: number; tau: number };
  /** Features of the window before the move and of a window after it has settled, live against a static bake at the same input value (no scale snap). */
  before: { live: Partial<Record<FeatureKey, number>>; staticBake: Partial<Record<FeatureKey, number>> };
  after: { live: Partial<Record<FeatureKey, number>>; staticBake: Partial<Record<FeatureKey, number>> };
  /** Largest sample-to-sample step in the 40 ms around the move, over the larger of the two static bakes' largest steps anywhere: about 1 or less means no click. */
  stepRatio: number;
  finite: boolean;
}

const slice = (p: Pcm, from: number, to: number): Pcm => {
  const a = Math.floor(from * p.sampleRate), b = Math.floor(to * p.sampleRate);
  return { sampleRate: p.sampleRate, delivered: p.delivered.map(c => c.slice(a, b)), authored: p.authored.map(c => c.slice(a, b)) };
};
const pickFeatures = (p: Pcm) => { const f = featuresOf(p); return { momentaryMaxLufs: f.momentaryMaxLufs, centroidHz: f.centroidHz, pitchHz: f.pitchHz, pitchStrength: f.pitchStrength } as Record<string, number>; };
const maxStep = (c: Float32Array, from: number, to: number) => { let m = 0; for (let i = Math.max(1, from); i < Math.min(c.length, to); i++) m = Math.max(m, Math.abs(c[i] - c[i - 1])); return m; };

/** Move a live input mid-note and compare with static bakes of the two input values. Chromium only. */
export async function runLive(cue: Cue, move: { input: string; to: number; at?: number; tau?: number }, { sampleWavs }: SampleTransportOptions = {}): Promise<LiveReport> {
  const decl = cue.patch.xRuntime!.inputs[move.input];
  if (!decl) throw new Error(`the patch declares no input "${move.input}"`);
  const at = move.at ?? 0.5, tau = move.tau ?? 0.03;
  const noSnap = cue.scale ? { ...cue.scale, snap: false } : undefined;
  const st = stage();
  const site = await serveStatic(st.dir);
  const browser = await launch('chromium');
  try {
    const { run } = await session(browser, site.url);
    const base = { patch: cue.patch, seed: cue.seed, variant: 0, scale: noSnap, trimDb: cue.trimDb, sampleWavs: selectSampleWavs(cue.patch, sampleWavs) };
    const bakeFrom = await run({ ...base, kind: 'baked', params: { [move.input]: decl.default } });
    const bakeTo = await run({ ...base, kind: 'baked', params: { [move.input]: move.to } });
    const live = await run({ ...base, kind: 'runtime', params: {}, live: [{ at, input: move.input, value: move.to, tau }] });
    const settled = at + tau * 8;
    const winBefore: [number, number] = [at - 0.25, at - 0.02];
    const winAfter: [number, number] = [settled, settled + 0.25];
    const sr = live.sampleRate;
    const around = [Math.floor((at - 0.02) * sr), Math.floor((at + 0.02) * sr)] as const;
    const liveStep = maxStep(live.delivered[0], ...around);
    const staticStep = Math.max(maxStep(bakeFrom.delivered[0], 0, bakeFrom.delivered[0].length), maxStep(bakeTo.delivered[0], 0, bakeTo.delivered[0].length), 1e-9);
    return {
      cue: cue.id, move: { input: move.input, from: decl.default, to: move.to, at, tau },
      before: { live: pickFeatures(slice(live, ...winBefore)), staticBake: pickFeatures(slice(bakeFrom, ...winBefore)) },
      after: { live: pickFeatures(slice(live, ...winAfter)), staticBake: pickFeatures(slice(bakeTo, ...winAfter)) },
      stepRatio: liveStep / staticStep,
      finite: live.delivered.every(c => c.every(Number.isFinite)),
    };
  } finally { await browser.close(); site.server.close(); st.cleanup(); }
}

/** Render one cue at given inputs through the baked path and the runtime voice in one browser (fresh page each), for looks and spot checks. */
export async function renderKinds(cue: Cue, params: Record<string, number>, { engine = 'chromium' as EngineName, variant = 0, seed = cue.seed, noSnap = false, sampleWavs }: SampleTransportOptions & { engine?: EngineName; variant?: number; seed?: number; noSnap?: boolean } = {}): Promise<Record<Kind, Pcm>> {
  const st = stage();
  const site = await serveStatic(st.dir);
  const browser = await launch(engine);
  try {
    const { run } = await session(browser, site.url);
    const c: ParityCase = { label: 'look', params, variant, seed, ...(noSnap ? { scale: 'none' as const } : {}) };
    return { baked: await run(specOf(cue, c, 'baked', cue.scale, sampleWavs)), runtime: await run(specOf(cue, c, 'runtime', cue.scale, sampleWavs)) };
  } finally { await browser.close(); site.server.close(); st.cleanup(); }
}
