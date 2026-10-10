// EXPERIMENTAL (runtime-codegen spike). Render every cue through the baked path, the interpreter and the generated module, in the
// same browser, with the same seed, and say how far apart they are. `beeps runtime parity` is the CLI face of this; the tests use it too.
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RUNTIME_DIR, serveStatic, openRenderHost } from '../render/host.ts';
import { applyParams } from '../../runtime/engine/params.js';
import type { Patch } from '../schema/patch.ts';
import type { Scale } from '../schema/project.ts';
import { diffTap, featureDelta, featuresOf, type FeatureKey, type Pcm, type TapDiff } from './compare.ts';
import { exportRuntime, type CueInput } from './export.ts';

export type Kind = 'baked' | 'interp' | 'gen';
export type EngineName = 'chromium' | 'firefox' | 'webkit';

export interface ParityCase {
  label: string;
  params: Record<string, number>;
  variant: number;
  seed: number;
  /** 'none' renders without scale snapping, so a live (continuous) input is compared with a bake that does not quantise it. */
  scale?: 'project' | 'none';
  /** Live bindings are applied as fixed numbers in the baked reference. A case with a mid-note `set` has no baked equal. */
  live?: { at: number; input: string; value: number; tau: number }[];
}

export interface Spec { kind: Kind; name: string; patch: Patch; params: Record<string, number>; seed: number; variant: number; scale: Scale; trimDb: number; live?: ParityCase['live'] }

export interface CaseReport {
  cue: string;
  case: string;
  /** interp and gen against baked, same browser. */
  interp: { delivered: TapDiff; authored: TapDiff; features: Record<FeatureKey, number> };
  gen: { delivered: TapDiff; authored: TapDiff; features: Record<FeatureKey, number> };
  /** Negative control: the generated module at seed + 1 against the baked reference. It must differ, or the comparison proves nothing. */
  control: TapDiff;
  /** SHA-256 prefix of the delivered samples for 5 fresh-page runs of each kind: how many distinct renders came out. */
  distinct: Record<Kind, number>;
  /** baked rendered by the production render host equals baked rendered by this harness (chromium only). */
  hostEqualsHarness?: boolean;
}

const b64 = (s: string): Float32Array => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const unpack = (r: any): Pcm => ({ sampleRate: r.sampleRate, delivered: r.delivered.map(b64), authored: r.authored.map(b64) });
const hash = (p: Pcm) => { const h = createHash('sha256'); for (const c of [...p.delivered, ...p.authored]) h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength)); return h.digest('hex').slice(0, 12); };

/** Stage a folder the harness page can be served from: the vendored runtime, the interpreter, a full engine copy for the baked path, the page. */
export function stage(cues: CueInput[], { codegen = true }: { codegen?: boolean } = {}): { dir: string; cleanup(): void } {
  const base = mkdtempSync(join(tmpdir(), 'beeps-parity-'));
  const { root } = exportRuntime(base, cues, { interpreter: true, codegen });
  cpSync(join(RUNTIME_DIR, 'engine'), join(root, 'baked'), { recursive: true });
  copyFileSync(join(import.meta.dirname, 'parity-page.js'), join(root, 'parity-page.js'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><meta charset="utf-8"><title>parity</title><script type="module" src="./parity-page.js"></script>');
  return { dir: root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export const defaultCases = (patch: Patch, seed: number): ParityCase[] => {
  const inputs = Object.entries(patch.xRuntime?.inputs ?? {});
  const at = (pick: 'min' | 'max') => Object.fromEntries(inputs.map(([k, i]) => [k, i[pick]]));
  return [
    { label: 'defaults', params: {}, variant: 0, seed },
    { label: 'variant 2, other seed', params: {}, variant: 2, seed: seed + 13 },
    ...(inputs.length ? [
      { label: 'inputs at min', params: at('min'), variant: 0, seed },
      { label: 'inputs at max', params: at('max'), variant: 1, seed },
      { label: 'inputs at max, no scale snap', params: at('max'), variant: 0, seed, scale: 'none' as const },
    ] : []),
  ];
};

export async function launch(engine: EngineName) {
  const pw = await import('playwright');
  const type = pw[engine];
  return type.launch({ timeout: 60000 });
}

export interface ParityOptions { cues: CueInput[]; scale: Scale; engines: EngineName[]; runs: number; cases?: (p: Patch, seed: number) => ParityCase[] }
export interface EngineReport {
  engine: EngineName;
  version: string;
  /** webkit on Windows has no OfflineAudioContext: reported, never passed. */
  status?: 'ok' | 'no-web-audio' | 'unavailable';
  cases: CaseReport[];
  /** Cross-browser: this engine's gen and baked against chromium's baked, same case (absent for chromium itself). */
  vsChromium?: { cue: string; case: string; baked: TapDiff; gen: TapDiff; genFeatures: Record<FeatureKey, number> }[];
}

export async function runParity(o: ParityOptions): Promise<EngineReport[]> {
  const st = stage(o.cues);
  const site = await serveStatic(st.dir);
  const reports: EngineReport[] = [];
  /** chromium's baked reference per cue+case, for the cross-browser deltas. */
  const chromiumBaked = new Map<string, Pcm>();
  try {
    for (const engine of o.engines) {
      let browser;
      try { browser = await launch(engine); } catch (e) { reports.push({ engine, version: `unavailable: ${(e as Error).message.split('\n')[0]}`, cases: [] }); continue; }
      const page = async () => { const ctx = await browser.newContext(); const pg = await ctx.newPage(); await pg.goto(`${site.url}/index.html`); await pg.waitForFunction(() => (window as any).ready === true, null, { timeout: 30000 }); return { pg, ctx }; };
      const run = async (spec: Spec): Promise<Pcm> => {
        const { pg, ctx } = await page();
        try { return unpack(await pg.evaluate((s: Spec) => (window as any).run(s), spec)); } finally { await ctx.close(); }
      };
      {
        const ctx = await browser.newContext();
        const pg = await ctx.newPage();
        const has = await pg.evaluate(() => typeof (window as any).OfflineAudioContext === 'function');
        await ctx.close();
        if (!has) { reports.push({ engine, version: browser.version(), status: 'no-web-audio', cases: [] }); await browser.close(); continue; }
      }
      const report: EngineReport = { engine, version: browser.version(), cases: [], ...(engine !== 'chromium' ? { vsChromium: [] } : {}) };
      const host = engine === 'chromium' ? await openRenderHost() : undefined;
      try {
        for (const cue of o.cues) {
          for (const c of (o.cases ?? defaultCases)(cue.patch, cue.seed)) {
            const spec = (kind: Kind): Spec => ({ kind, name: cue.patch.name, patch: cue.patch, params: c.params, seed: c.seed, variant: c.variant, scale: c.scale === 'none' ? { ...o.scale, snap: false } : o.scale, trimDb: cue.trimDb, live: c.live });
            const baked: Pcm[] = [], interp: Pcm[] = [], gen: Pcm[] = [];
            for (let i = 0; i < o.runs; i++) { baked.push(await run(spec('baked'))); interp.push(await run(spec('interp'))); gen.push(await run(spec('gen'))); }
            const key = `${cue.patch.name}|${c.label}`;
            if (engine === 'chromium') chromiumBaked.set(key, baked[0]);
            const refF = featuresOf(baked[0]);
            const cmp = (p: Pcm) => ({ delivered: diffTap(baked[0].delivered, p.delivered), authored: diffTap(baked[0].authored, p.authored), features: featureDelta(refF, featuresOf(p)) });
            const control = diffTap(baked[0].delivered, (await run({ ...spec('gen'), seed: c.seed + 1 })).delivered);
            let hostEqualsHarness: boolean | undefined;
            if (host) {
              const { patch: applied, trimDeltaDb } = applyParams(cue.patch, c.params, true);
              const [r] = await host.render([{ patch: applied, opts: { seed: c.seed, variant: c.variant, scale: spec('baked').scale, trimDb: cue.trimDb + trimDeltaDb } }]);
              hostEqualsHarness = r.ok && diffTap(r.delivered, baked[0].delivered).bitExact && diffTap(r.authored, baked[0].authored).bitExact;
            }
            report.cases.push({
              cue: cue.patch.name, case: c.label, interp: cmp(interp[0]), gen: cmp(gen[0]), control,
              distinct: { baked: new Set(baked.map(hash)).size, interp: new Set(interp.map(hash)).size, gen: new Set(gen.map(hash)).size },
              ...(hostEqualsHarness === undefined ? {} : { hostEqualsHarness }),
            });
            if (engine !== 'chromium') {
              const ref = chromiumBaked.get(key);
              if (ref) report.vsChromium!.push({ cue: cue.patch.name, case: c.label, baked: diffTap(ref.delivered, baked[0].delivered), gen: diffTap(ref.delivered, gen[0].delivered), genFeatures: featureDelta(featuresOf(ref), featuresOf(gen[0])) });
            }
          }
        }
      } finally { await host?.close(); await browser.close(); }
      reports.push(report);
    }
  } finally { site.server.close(); st.cleanup(); }
  return reports;
}

/** Time graph builds (cold and warm) and count the nodes and buffers they create, in one browser. */
export async function runPerf(cues: CueInput[], scale: Scale, { n = 60, engine = 'chromium' as EngineName } = {}) {
  const st = stage(cues);
  const site = await serveStatic(st.dir);
  const browser = await launch(engine);
  const out: { cue: string; kind: Kind; firstMs: number; medianMs: number; p95Ms: number; maxMs: number; warmCounts: Record<string, number>; firstCounts: Record<string, number> }[] = [];
  try {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await pg.goto(`${site.url}/index.html`);
    await pg.waitForFunction(() => (window as any).ready === true);
    for (const cue of cues) for (const kind of ['interp', 'gen'] as const) {
      // a fresh page per measurement: the noise and reverb caches are per context, but module-level caches should start cold too
      const p2 = await ctx.newPage();
      await p2.goto(`${site.url}/index.html`);
      await p2.waitForFunction(() => (window as any).ready === true);
      const spec = { kind, name: cue.patch.name, patch: cue.patch, params: {}, seed: cue.seed, variant: 0, scale, trimDb: cue.trimDb };
      const r = await p2.evaluate(([s, count]) => (window as any).perf(s, count), [spec, n] as const) as any;
      out.push({ cue: cue.patch.name, kind, ...r });
      await p2.close();
    }
  } finally { await browser.close(); site.server.close(); st.cleanup(); }
  return out;
}

void mkdirSync;

export interface LiveReport {
  cue: string;
  kind: Kind;
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
export async function runLive(cue: CueInput, scale: Scale, move: { input: string; to: number; at?: number; tau?: number }): Promise<LiveReport[]> {
  const rt = cue.patch.xRuntime!;
  const decl = rt.inputs[move.input];
  const at = move.at ?? 0.5, tau = move.tau ?? 0.03;
  const noSnap = { ...scale, snap: false };
  const st = stage([cue]);
  const site = await serveStatic(st.dir);
  const browser = await launch('chromium');
  try {
    const run = async (spec: Spec): Promise<Pcm> => {
      const ctx = await browser.newContext(); const pg = await ctx.newPage();
      try {
        await pg.goto(`${site.url}/index.html`);
        await pg.waitForFunction(() => (window as any).ready === true);
        return unpack(await pg.evaluate((s: Spec) => (window as any).run(s), spec));
      } finally { await ctx.close(); }
    };
    const base = { name: cue.patch.name, patch: cue.patch, seed: cue.seed, variant: 0, scale: noSnap, trimDb: cue.trimDb };
    const bakeFrom = await run({ ...base, kind: 'baked', params: { [move.input]: decl.default } });
    const bakeTo = await run({ ...base, kind: 'baked', params: { [move.input]: move.to } });
    const out: LiveReport[] = [];
    for (const kind of ['gen', 'interp'] as const) {
      const live = await run({ ...base, kind, params: {}, live: [{ at, input: move.input, value: move.to, tau }] });
      const settled = at + tau * 8;
      const winBefore: [number, number] = [at - 0.25, at - 0.02];
      const winAfter: [number, number] = [settled, settled + 0.25];
      const sr = live.sampleRate;
      const around = [Math.floor((at - 0.02) * sr), Math.floor((at + 0.02) * sr)] as const;
      const liveStep = maxStep(live.delivered[0], ...around);
      const staticStep = Math.max(maxStep(bakeFrom.delivered[0], 0, bakeFrom.delivered[0].length), maxStep(bakeTo.delivered[0], 0, bakeTo.delivered[0].length), 1e-9);
      out.push({
        cue: cue.patch.name, kind, move: { input: move.input, from: decl.default, to: move.to, at, tau },
        before: { live: pickFeatures(slice(live, ...winBefore)), staticBake: pickFeatures(slice(bakeFrom, ...winBefore)) },
        after: { live: pickFeatures(slice(live, ...winAfter)), staticBake: pickFeatures(slice(bakeTo, ...winAfter)) },
        stepRatio: liveStep / staticStep,
        finite: live.delivered.every(c => c.every(Number.isFinite)),
      });
    }
    return out;
  } finally { await browser.close(); site.server.close(); st.cleanup(); }
}
