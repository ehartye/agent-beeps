// EXPERIMENTAL (runtime-codegen spike). Option B: one patch becomes one small ES module whose `build(ctx, out, params, seed, opts)`
// constructs the patch's Web Audio graph in straight-line code, with no patch data and no interpreter in it.
//
// The emitter is a transcription of runtime/engine/{patch,layer,sources}.js specialised to one patch: every branch the patch
// decides (source type, which layers have a filter, how many partials) is taken here, at emit time; only what a runtime input,
// a variant or the caller's scale can change is left as an expression. tests/codegen/ proves the transcription by building the
// same patch through the engine and through the module on a recording context and comparing the two graphs node for node, then
// by rendering both in Chromium and comparing samples.
import type { Patch } from '../schema/patch.ts';
import { noteToHz } from '../../runtime/engine/notes.js';
import { ENGINE_VERSION } from '../../runtime/engine/version.js';
import { isLiveTarget, MACROS, targetsOf, unitOf, type RuntimeBind, type RuntimeBlock } from '../../runtime/engine/params.js';
import { METAL_RATIOS } from '../../runtime/engine/sources.js';
import { REVERB_PRESETS } from '../../runtime/engine/fx.js';
import { BeepsError } from '../errors.ts';

export interface EmitOptions {
  /** Loudness trim in dB measured for the patch at its default inputs; baked into `meta` and used when the caller passes none. */
  trimDb: number;
  /** The seed the trim was measured at (informational: the game passes its own). */
  seed?: number;
  /** sha256 of the canonical patch JSON, recorded so `verify` can tell a stale module. */
  patchHash?: string;
}
export interface Emitted { js: string; dts: string; imports: string[]; liveInputs: string[]; staticInputs: string[] }

const lit = (n: number): string => (n < 0 || Object.is(n, -0) ? `(${n})` : String(n));
const J = (v: unknown): string => JSON.stringify(v);

/** Source types the emitter supports. `voice` stays on the interpreter in this spike. */
export const CODEGEN_SOURCES = ['osc', 'noise', 'fm', 'additive', 'modal', 'grains', 'metal'] as const;

interface Bound { k: number; bind: RuntimeBind; targets: string[] }

export function emitModule(patch: Patch, opts: EmitOptions): Emitted {
  const rt = patch.xRuntime as RuntimeBlock | undefined;
  const hold = rt?.hold === true;
  for (const [i, l] of patch.layers.entries()) {
    if (!(CODEGEN_SOURCES as readonly string[]).includes(l.source.type)) {
      throw new BeepsError('E_USAGE', `layer ${i}: the "${l.source.type}" source is not supported by runtime codegen yet`, { hint: 'deliver this patch baked, or through the interpreter (createVoice)', pointer: `/layers/${i}/source/type` });
    }
  }
  const binds: Bound[] = (rt?.bind ?? []).map((bind, k) => ({ k, bind, targets: targetsOf(patch, bind) }));
  const statics = binds.filter(b => !b.bind.live);
  const lives = binds.filter(b => b.bind.live);
  const variation = patch.variation && (patch.variation.pitchCents || patch.variation.gainDb) ? patch.variation : undefined;

  const imports = new Set<string>(['G', 'db', 'voice']);
  const use = (...names: string[]) => names.forEach(n => imports.add(n));

  /**
   * The JS expression for a numeric patch field: its literal, then every static binding that reaches it, in bind order, exactly
   * as `applyParams` applies them. `kind` marks fields a macro reaches: 'pitch' (transpose) and 'cutoff' (brightness).
   */
  const val = (path: string, literal: number, kind?: 'pitch' | 'cutoff'): string => {
    let x = lit(literal);
    for (const b of statics) {
      for (const t of b.targets) {
        const hit = t === path || (kind === 'pitch' && t === '/out/transpose') || (kind === 'cutoff' && t === '/out/brightness');
        if (!hit) continue;
        const unit = b.bind.unit ?? unitOf(t);
        x = unit === 'oct' ? `(${x} * 2 ** d${b.k})` : unit === 'st' ? `(${x} * 2 ** (d${b.k} / 12))` : `(${x} + d${b.k})`;
        if (b.bind.clamp) { use('cl'); x = `cl(d${b.k}, ${x}, ${lit(b.bind.clamp[0])}, ${lit(b.bind.clamp[1])})`; }
      }
    }
    return x;
  };
  const hz = (p: string | number) => (typeof p === 'number' ? p : noteToHz(p));
  /** A pitch value: transposed, varied, then resolved against the scale the way `resolvePitch` does. */
  const pitchExpr = (path: string, p: string | number, varied: boolean) => {
    use('rp');
    return `rp(${val(path, hz(p), 'pitch')}${varied && variation ? ' * vp' : ''}, scale)`;
  };

  const liveMap = new Map<string, { exprs: string[]; kind: string; binds: [string, number, number, string?][] }>();
  const addLive = (key: string, expr: string, kind: string, bind: RuntimeBind) => {
    let e = liveMap.get(key);
    if (!e) liveMap.set(key, e = { exprs: [expr], kind, binds: [] });
    e.binds.push([bind.input, bind.range[0], bind.range[1], ...(bind.shape ? [bind.shape] : [])] as [string, number, number, string?]);
  };

  const L: string[] = [];
  const emit = (s: string) => L.push(s);
  const dur = val('/duration', patch.duration);

  emit(`export function build(ctx, out, params = {}, seed = 1, o = {}) {`);
  emit(`  const { when = 0, variant = 0, scale, limiter = true } = o;`);
  emit(`  const trimDb = o.trimDb ?? meta.trimDb;`);
  if (variation) { use('vary'); emit(`  const [vp, vg] = variant ? vary(seed, variant, ${variation.pitchCents}, ${variation.gainDb}) : [1, 0];`); }
  if (statics.length) {
    use('bd');
    for (const b of statics) {
      const i = rt!.inputs[b.bind.input];
      emit(`  const d${b.k} = bd(params.${b.bind.input}, ${lit(i.default)}, ${lit(i.min)}, ${lit(i.max)}, ${lit(b.bind.range[0])}, ${lit(b.bind.range[1])}${b.bind.shape ? `, ${J(b.bind.shape)}` : ''});`);
    }
    const trims = statics.filter(b => b.targets.includes('/out/gainDb'));
    if (trims.length) { emit(`  let tdb = 0;`); for (const b of trims) emit(`  tdb += d${b.k};`); }
  }
  const hasTrimDelta = statics.some(b => b.targets.includes('/out/gainDb'));
  emit(`  const dur = ${dur};`);
  emit(`  const mix = G(ctx);`);
  emit(`  const authored = G(ctx);`);
  emit(`  let end = when;`);
  if (hold) emit(`  const rel = [];`);
  const dry = patch.fx?.dcBlock ? (use('buildDcBlocker'), 'dry') : 'mix';
  if (patch.fx?.dcBlock) emit(`  const dry = mix.connect(buildDcBlocker(ctx));`);
  emit(`  const toAuthored = [${dry}];`);
  emit(`  const outs = [];`);

  patch.layers.forEach((layer, j) => {
    const P = (s: string) => `/layers/${j}/${s}`;
    const src = layer.source as any;
    const amp = layer.amp;
    emit(`  {`);
    emit(`    const lo = G(ctx);`);
    emit(`    outs.push(lo);`);
    emit(`    const lseed = seed + ${j * 7919};`);
    emit(`    const t0 = when + ${val(P('start'), layer.start)};`);
    emit(`    const at = ${val(P('amp/attack'), amp.attack)}, dc = ${val(P('amp/decay'), amp.decay)}, su = ${val(P('amp/sustain'), amp.sustain)}, re = ${val(P('amp/release'), amp.release)};`);
    emit(`    const off = Math.max(t0 + Math.min(at, 0.002), when + dur);`);
    emit(`    const fin = off + re;`);
    // ---- source (transcription of buildSource) ----
    const hasPitch = 'pitch' in src;
    if (hasPitch) emit(`    const base = ${pitchExpr(P('source/pitch'), src.pitch, true)};`);
    else emit(`    const base = 440;`);
    emit(`    const sm = G(ctx);`);
    emit(`    const nd = [], pi = [], dt = [], pt = [], os = [];`);
    switch (src.type) {
      case 'osc': {
        const V = src.unison?.voices ?? 1, S = src.unison?.detuneCents ?? 0;
        emit(`    for (let i = 0; i < ${V}; i++) {`);
        emit(`      const x = ctx.createOscillator();`);
        emit(`      x.type = ${J(src.wave)};`);
        emit(`      x.frequency.value = base;`);
        emit(`      x.detune.value = ${V === 1 ? '0' : `-${S} / 2 + (${S} * i) / (${V} - 1)`};`);
        emit(`      const g = G(ctx, 1 / ${V});`);
        emit(`      pt.push(x.connect(g)); nd.push(x); pi.push([x.frequency, 1]); dt.push(x.detune);`);
        emit(`    }`);
        break;
      }
      case 'noise': {
        use('noiseBuffer', 'widthOf');
        emit(`    const s = ctx.createBufferSource();`);
        emit(`    s.buffer = noiseBuffer(ctx, ${J(src.color)}, lseed, widthOf(${J(src.stereo)}));`);
        emit(`    s.loop = true;`);
        emit(`    pt.push(s); nd.push(s);`);
        break;
      }
      case 'fm': {
        const ops = src.operators as { ratio: number; index: number; wave: string }[];
        emit(`    const ops = ${J(ops.map(o => [o.ratio, o.index, o.wave]))}.map(([r, , w]) => {`);
        emit(`      const x = ctx.createOscillator();`);
        emit(`      x.type = w;`);
        emit(`      x.frequency.value = base * r;`);
        emit(`      nd.push(x); pi.push([x.frequency, r]); dt.push(x.detune);`);
        emit(`      return x;`);
        emit(`    });`);
        emit(`    const mods = ops.map(() => []);`);
        use('sumInto');
        const alg = (src.algorithm as [number, number][]).filter(([f, t]) => f < ops.length && t < ops.length && f !== t);
        for (const [from, to] of alg) {
          emit(`    { const dp = G(ctx, ${lit(ops[from].index)} * base * ${lit(ops[to].ratio)}); mods[${to}].push(ops[${from}].connect(dp)); }`);
        }
        emit(`    mods.forEach((m, i) => sumInto(ctx, m, ops[i].frequency));`);
        emit(`    pt.push(ops[0]);`);
        break;
      }
      case 'additive': {
        use('nyquistSafe');
        const parts = src.partials as [number, number, number][];
        const total = parts.reduce((a, [, g]) => a + 10 ** (g / 20), 0) || 1;
        emit(`    const total = ${J(total)};`);
        emit(`    for (const [r, gdb, dcy] of ${J(parts)}) {`);
        emit(`      if (!nyquistSafe(ctx, base * r)) continue;`);
        emit(`      const x = ctx.createOscillator();`);
        emit(`      x.frequency.value = base * r;`);
        emit(`      const g = G(ctx, 0);`);
        emit(`      pt.push(x.connect(g)); nd.push(x); pi.push([x.frequency, r]); dt.push(x.detune);`);
        emit(`      os.push(t => { g.gain.setValueAtTime(db(gdb) / total, t); g.gain.setTargetAtTime(0, t, dcy / 5); });`);
        emit(`    }`);
        break;
      }
      case 'modal': {
        use('nyquistSafe', 'exciterBuffer');
        emit(`    const ex = ctx.createBufferSource();`);
        emit(`    ex.buffer = exciterBuffer(ctx, ${J(src.exciter)}, lseed);`);
        emit(`    nd.push(ex);`);
        emit(`    for (const [r, q, gdb] of ${J(src.modes)}) {`);
        emit(`      if (!nyquistSafe(ctx, base * r)) continue;`);
        emit(`      const bp = ctx.createBiquadFilter();`);
        emit(`      bp.type = 'bandpass';`);
        emit(`      bp.frequency.value = base * r;`);
        emit(`      bp.Q.value = q;`);
        emit(`      const g = G(ctx, db(gdb) * q * 4);`);
        emit(`      pt.push(ex.connect(bp).connect(g)); pi.push([bp.frequency, r]);`);
        emit(`    }`);
        break;
      }
      case 'grains': {
        use('grainBuffer');
        emit(`    const s = ctx.createBufferSource();`);
        emit(`    s.buffer = grainBuffer(ctx, ${J({ rate: src.rate, rateEnd: src.rateEnd, grainDecay: src.grainDecay, stereo: src.stereo })}, lseed, fin - t0);`);
        emit(`    const bp = ctx.createBiquadFilter();`);
        emit(`    bp.type = 'bandpass';`);
        emit(`    bp.frequency.value = ${lit(src.center)};`);
        emit(`    bp.Q.value = ${lit(src.q)};`);
        emit(`    pt.push(s.connect(bp)); nd.push(s);`);
        break;
      }
      case 'metal': {
        use('sumInto');
        emit(`    const sum = G(ctx, 1 / ${METAL_RATIOS.length});`);
        emit(`    const sq = ${J(METAL_RATIOS)}.map(r => {`);
        emit(`      const x = ctx.createOscillator();`);
        emit(`      x.type = 'square';`);
        emit(`      x.frequency.value = ${val(P('source/base'), src.base, 'pitch')} * r;`);
        emit(`      nd.push(x); dt.push(x.detune);`);
        emit(`      return x;`);
        emit(`    });`);
        emit(`    sumInto(ctx, sq, sum);`);
        emit(`    for (const band of ${J(src.bands)}) {`);
        emit(`      const bp = ctx.createBiquadFilter();`);
        emit(`      bp.type = 'bandpass';`);
        emit(`      bp.frequency.value = band;`);
        emit(`      bp.Q.value = 1.5;`);
        emit(`      pt.push(sum.connect(bp));`);
        emit(`    }`);
        break;
      }
    }
    use('sumInto', 'go', 'halt');
    emit(`    sumInto(ctx, pt, sm);`);
    // ---- layer (transcription of buildLayer) ----
    if (layer.pitchEnv?.length) {
      use('penv');
      const pts = layer.pitchEnv.map((p, n) => `[${p.at}, ${pitchExpr(P(`pitchEnv/${n}/to`), p.to, true)}, ${p.curve === 'step' ? 2 : p.curve === 'linear' ? 1 : 0}]`);
      emit(`    penv(pi, base, t0, [${pts.join(', ')}]);`);
    }
    emit(`    let node = sm;`);
    if (layer.drive !== undefined && layer.drive !== null) {
      use('driveCurve');
      emit(`    const dr = ${val(P('drive'), layer.drive)};`);
      emit(`    if (dr) { const sh = ctx.createWaveShaper(); sh.curve = driveCurve(dr); sh.oversample = '4x'; node = node.connect(sh); }`);
    }
    let hasFilter = false;
    if (layer.filter) {
      hasFilter = true;
      const f = layer.filter as any;
      emit(`    const fl = ctx.createBiquadFilter();`);
      emit(`    fl.type = ${J(f.type)};`);
      emit(`    const cut = ${val(P('filter/cutoff'), f.cutoff, 'cutoff')};`);
      emit(`    fl.frequency.value = cut;`);
      emit(`    fl.Q.value = ${lit('resonanceDb' in f ? f.resonanceDb : f.q)};`);
      if ('gainDb' in f && f.gainDb !== undefined) emit(`    fl.gain.value = ${lit(f.gainDb)};`);
      if (f.env) {
        emit(`    fl.frequency.setValueAtTime(cut, t0);`);
        emit(`    fl.frequency.exponentialRampToValueAtTime(Math.max(1, ${val(P('filter/env/to'), f.env.to, 'cutoff')}), t0 + ${val(P('filter/env/time'), f.env.time)});`);
      }
      emit(`    node = node.connect(fl);`);
    }
    emit(`    const amp = ctx.createGain();`);
    emit(`    amp.gain.setValueAtTime(0, t0);`);
    emit(`    if (at > 0) amp.gain.linearRampToValueAtTime(1, t0 + at); else amp.gain.setValueAtTime(1, t0);`);
    emit(`    if (dc > 0 && su < 1) amp.gain.setTargetAtTime(su, t0 + at, dc / 3);`);
    use('envelopeAt');
    emit(`    const sr = at2 => { amp.gain.setValueAtTime(envelopeAt({ attack: at, decay: dc, sustain: su }, at2 - t0), at2); amp.gain.linearRampToValueAtTime(0, at2 + re); return at2 + re; };`);
    if (!hold) emit(`    sr(off);`);
    emit(`    node = node.connect(amp);`);
    if (layer.highpass !== undefined) {
      emit(`    { const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = ${val(P('highpass'), layer.highpass)}; hp.Q.value = 0; node = node.connect(hp); }`);
    }
    if (layer.lfo) {
      const l = layer.lfo;
      emit(`    const lfo = ctx.createOscillator();`);
      emit(`    lfo.frequency.value = ${val(P('lfo/rate'), l.rate)};`);
      emit(`    const ld = G(ctx, ${val(P('lfo/depth'), l.depth)});`);
      emit(`    lfo.connect(ld);`);
      if (l.target === 'pitch') emit(`    for (const p of dt) ld.connect(p);`);
      else if (l.target === 'cutoff' && hasFilter) emit(`    ld.connect(fl.frequency);`);
      else if (l.target === 'gain') {
        emit(`    { const dep = ${val(P('lfo/depth'), l.depth)}; const tr = G(ctx, 1 - Math.min(1, dep) / 2); ld.gain.value = Math.min(1, dep) / 2; ld.connect(tr.gain); node = node.connect(tr); }`);
      }
      emit(`    lfo.start(t0);`);
      if (!hold) emit(`    lfo.stop(fin);`);
    }
    let hasPan = false;
    if (layer.pan !== undefined) {
      hasPan = true;
      emit(`    let pn;`);
      emit(`    const pv = ${val(P('pan'), layer.pan)};`);
      emit(`    if (pv !== 0) { pn = ctx.createStereoPanner(); pn.pan.value = pv; node = node.connect(pn); }`);
    }
    emit(`    const lg = G(ctx, db(${val(P('gainDb'), layer.gainDb)}${variation ? ' + vg' : ''}));`);
    emit(`    node.connect(lg).connect(lo);`);
    emit(`    go(nd, os, t0);`);
    if (!hold) {
      emit(`    halt(nd, fin + 0.01);`);
      emit(`    end = Math.max(end, fin);`);
    } else {
      emit(`    end = Infinity;`);
      emit(`    rel.push(a => { const s = sr(Math.max(a, t0 + Math.min(at, 0.002))); halt(nd, s + 0.01);${layer.lfo ? ' lfo.stop(s);' : ''} return s; });`);
    }
    // ---- live targets this layer owns ----
    for (const b of lives) for (const t of b.targets) {
      if (!isLiveTarget(t)) throw new BeepsError('E_SCHEMA', `bind ${b.k}: ${t} cannot be live`, { pointer: `/xRuntime/bind/${b.k}/live` });
      const key = (s: string) => `${j}:${s}`;
      if (t === '/out/transpose') {
        if (dtSupported(src.type)) addLive(key('dt'), `...refs[${j}].dt`, 'st', b.bind);
      } else if (t === '/out/brightness') {
        if (hasFilter) addLive(key('fd'), `refs[${j}].fl.detune`, 'ct', b.bind);
      } else if (t === P('gainDb')) addLive(key('lg'), `refs[${j}].lg.gain`, 'gain', b.bind);
      else if (t === P('filter/cutoff')) { if (hasFilter) addLive(key('fd'), `refs[${j}].fl.detune`, 'ct', b.bind); }
      else if (t === P('pan')) { if (hasPan) addLive(key('pn'), `refs[${j}].pn?.pan`, 'pan', b.bind); }
      else if (t === P('lfo/rate')) { if (layer.lfo) addLive(key('lr'), `refs[${j}].lfo.frequency`, 'oct', b.bind); }
    }
    // Hoist the references the live list needs out of the block scope.
    emit(`    refs.push({ dt, fl: ${hasFilter ? 'fl' : 'undefined'}, lg, pn: ${hasPan ? 'pn' : 'undefined'}, lfo: ${layer.lfo ? 'lfo' : 'undefined'} });`);
    emit(`  }`);
  });
  // `refs` is declared before the layers; patch it in.
  const body = L.join('\n').replace('  const outs = [];', '  const outs = [], refs = [];');

  // ---- patch level (transcription of buildPatch) ----
  const T: string[] = [];
  const t = (s: string) => T.push(s);
  t(`  sumInto(ctx, outs, mix);`);
  t(`  let tail = 0;`);
  if (patch.fx?.reverb) {
    const r = patch.fx.reverb;
    use('buildReverb');
    t(`  const rsend = G(ctx, db(${val('/fx/reverb/sendDb', r.sendDb)}));`);
    t(`  toAuthored.push(${dry}.connect(rsend).connect(buildReverb(ctx, ${J(r.preset)})));`);
    t(`  tail = Math.max(tail, ${REVERB_PRESETS[r.preset].decay + REVERB_PRESETS[r.preset].preDelay});`);
  }
  if (patch.fx?.delay) {
    const d = patch.fx.delay;
    use('buildDelay');
    const dtail = Math.min(8, d.feedback <= 0 ? d.time : d.time * Math.ceil(Math.log(0.01) / Math.log(d.feedback)));
    t(`  const dsend = G(ctx, db(${val('/fx/delay/sendDb', d.sendDb)}));`);
    t(`  const dl = buildDelay(ctx, { time: ${d.time}, feedback: ${d.feedback} });`);
    t(`  ${dry}.connect(dsend).connect(dl.input);`);
    t(`  toAuthored.push(dl.output);`);
    t(`  tail = Math.max(tail, ${dtail});`);
  }
  t(`  sumInto(ctx, toAuthored, authored);`);
  t(`  const trim = G(ctx, db(trimDb${hasTrimDelta ? ' + tdb' : ''}));`);
  t(`  authored.connect(trim);`);
  t(`  if (o.tap) authored.connect(o.tap);`);
  use('buildLimiter');
  t(`  if (limiter) trim.connect(buildLimiter(ctx)).connect(out); else trim.connect(out);`);

  // live: the patch-level targets, then the per-layer ones gathered above (their expressions name hoisted refs)
  for (const b of lives) for (const tg of b.targets) {
    if (tg === '/out/gainDb') addLive('trim', 'trim.gain', 'gain', b.bind);
    else if (tg === '/fx/reverb/sendDb' && patch.fx?.reverb) addLive('rsend', 'rsend.gain', 'gain', b.bind);
    else if (tg === '/fx/delay/sendDb' && patch.fx?.delay) addLive('dsend', 'dsend.gain', 'gain', b.bind);
  }
  let setExpr = 'undefined';
  if (liveMap.size) {
    use('makeLive');
    const entries: string[] = [];
    for (const e of liveMap.values()) {
      for (const ex of e.exprs) {
        const spread = ex.startsWith('...');
        const expr = spread ? ex.slice(3) : ex;
        const entry = (p: string) => `[${p}, ${J(e.kind)}, ${J(e.binds)}]`;
        entries.push(spread ? `...${expr}.map(p => ${entry('p')})` : entry(expr));
      }
    }
    t(`  const set = makeLive(meta.inputs, { ...defaults, ...params }, [${entries.join(', ')}].filter(e => e[0]), () => ctx.currentTime);`);
    setExpr = 'set';
  }
  t(`  return voice(ctx, trim, ${hold ? 'Infinity' : 'end + tail'}, ${setExpr}, ${hold ? 'a => rel.reduce((m, f) => Math.max(m, f(a)), a)' : 'undefined'}, tail);`);
  t(`}`);

  const inputs = rt?.inputs ?? {};
  const defaults = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.default]));
  const metaObj = {
    name: patch.name, engine: ENGINE_VERSION, trimDb: opts.trimDb, seed: opts.seed ?? 1, duration: patch.duration, hold,
    intent: patch.meta?.intent ?? 'oneshot', variants: patch.variation?.variants ?? 1, inputs,
    live: [...new Set(lives.map(b => b.bind.input))], ...(opts.patchHash ? { patchHash: opts.patchHash } : {}),
  };
  const importList = [...imports].sort();
  const js = [
    `// Generated by \`beeps runtime emit\` (EXPERIMENTAL spike) from patch "${patch.name}", engine ${ENGINE_VERSION}. Do not edit: re-emit.`,
    `import { ${importList.join(', ')} } from '../engine/gen.js';`,
    ``,
    `export const meta = ${J(metaObj)};`,
    `const defaults = ${J(defaults)};`,
    ``,
    body,
    T.join('\n'),
    ``,
  ].join('\n');

  const dts = [
    `// Generated by \`beeps runtime emit\` (EXPERIMENTAL spike). Do not edit.`,
    `import type { Voice, BuildOptions } from '../engine/voice.d.ts';`,
    `export interface Params { ${Object.keys(inputs).map(k => `${k}?: number`).join('; ')} }`,
    `export declare const meta: { name: ${J(patch.name)}; engine: string; trimDb: number; seed: number; duration: number; hold: boolean; intent: string; variants: number; inputs: Record<${Object.keys(inputs).length ? Object.keys(inputs).map(k => J(k)).join(' | ') : 'never'}, { min: number; max: number; default: number; description?: string }>; live: string[]; patchHash?: string };`,
    `export declare function build(ctx: BaseAudioContext, out: AudioNode, params?: Params, seed?: number, opts?: BuildOptions): Voice;`,
    ``,
  ].join('\n');

  return { js, dts, imports: importList, liveInputs: meta_live(lives), staticInputs: [...new Set(statics.map(b => b.bind.input))] };
}

const meta_live = (lives: Bound[]) => [...new Set(lives.map(b => b.bind.input))];

/** Sources whose pitch can move live through detune cents (modal's bandpasses are the one pitched source without it). */
function dtSupported(type: string) { return type !== 'modal' && type !== 'noise' && type !== 'grains'; }

export { MACROS };
