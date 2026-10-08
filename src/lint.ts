// Craft lint: checks one patch (declaration + measured features) or a kit against craft/rules.json.
// Thresholds live in rules.json; this file only knows how to apply each rule id.
// Judgement rules are never skipped silently: every one in scope is listed in `judgement`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { noteToHz, snapToScale, hzToMidi } from '../runtime/engine/notes.js';
import { METAL_RATIOS } from '../runtime/engine/sources.js';
import type { Features } from './measure/index.ts';
import type { Patch } from './schema/patch.ts';
import type { Project } from './schema/project.ts';
import { targetFor } from './render/pipeline.ts';
import { BeepsError } from './errors.ts';

const Source = z.strictObject({ title: z.string().min(1), url: z.url() });
const Rule = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  statement: z.string().min(1),
  value: z.union([z.number(), z.record(z.string(), z.number())]).optional(),
  unit: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  check: z.enum(['auto', 'judgement']),
  severity: z.enum(['error', 'warn']),
  appliesTo: z.enum(['patch', 'kit', 'song']),
  rationale: z.string().optional(),
  sources: z.array(Source).min(1),
});
const RulesFile = z.strictObject({ $comment: z.string().optional(), schema: z.literal('beeps/rules@1'), rules: z.array(Rule).min(1) });

export type CraftRule = z.output<typeof Rule>;
export interface Finding { rule: string; message: string; pointer?: string }
export interface LintReport { errors: Finding[]; warnings: Finding[]; judgement: string[] }
export interface KitMember { patch: Patch; features: Features; priority: number }

export const RULES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'craft', 'rules.json');

let cached: CraftRule[] | undefined;
export function loadRules(path = RULES_PATH): CraftRule[] {
  if (path === RULES_PATH && cached) return cached;
  const r = RulesFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!r.success) throw new BeepsError('E_SCHEMA', `craft rules at ${path} are invalid: ${r.error.issues[0]?.message}`);
  const ids = new Set<string>();
  for (const rule of r.data.rules) {
    if (ids.has(rule.id)) throw new BeepsError('E_SCHEMA', `craft rule id "${rule.id}" is duplicated`);
    ids.add(rule.id);
  }
  if (path === RULES_PATH) cached = r.data.rules;
  return r.data.rules;
}

/** Collects findings, routing each to errors or warnings by the rule's severity (or an explicit one). */
export class Collector {
  readonly errors: Finding[] = [];
  readonly warnings: Finding[] = [];
  private readonly byId: Map<string, CraftRule>;
  constructor(rules: CraftRule[]) { this.byId = new Map(rules.map(r => [r.id, r])); }
  rule(id: string): CraftRule {
    const r = this.byId.get(id);
    if (!r) throw new BeepsError('E_SCHEMA', `craft rules are missing "${id}"`);
    return r;
  }
  num(id: string): number {
    const v = this.rule(id).value;
    if (typeof v !== 'number') throw new BeepsError('E_SCHEMA', `craft rule "${id}" needs a numeric value`);
    return v;
  }
  param<T>(id: string, key: string): T {
    const v = this.rule(id).params?.[key];
    if (v === undefined) throw new BeepsError('E_SCHEMA', `craft rule "${id}" is missing params.${key}`);
    return v as T;
  }
  add(id: string, message: string, pointer?: string, severity = this.rule(id).severity) {
    const f: Finding = { rule: id, message, ...(pointer !== undefined ? { pointer } : {}) };
    (severity === 'error' ? this.errors : this.warnings).push(f);
  }
  report(scope: 'patch' | 'kit' | 'song', rules: CraftRule[]): LintReport {
    return { errors: this.errors, warnings: this.warnings, judgement: rules.filter(r => r.check === 'judgement' && r.appliesTo === scope).map(r => r.id) };
  }
}

const fmt = (x: number, d = 3) => String(Math.round(x * 10 ** d) / 10 ** d);

/** Every declared frequency that reaches an oscillator or resonator, with the pointer that declares it. */
function declaredFrequencies(patch: Patch): { hz: number; pointer: string }[] {
  const out: { hz: number; pointer: string }[] = [];
  patch.layers.forEach((layer, i) => {
    const src = layer.source;
    const base = `/layers/${i}/source`;
    if (src.type === 'metal') {
      out.push({ hz: src.base * Math.max(...METAL_RATIOS), pointer: `${base}/base` });
      return;
    }
    if (!('pitch' in src)) return;
    const ratios: { r: number; pointer?: string }[] =
      src.type === 'fm' ? src.operators.map((op, k) => ({ r: op.ratio, pointer: `${base}/operators/${k}/ratio` }))
        : src.type === 'additive' ? src.partials.map(([r], k) => ({ r, pointer: `${base}/partials/${k}` }))
          : src.type === 'modal' ? src.modes.map(([r], k) => ({ r, pointer: `${base}/modes/${k}` }))
            : [{ r: 1 }];
    const pitches = [{ hz: noteToHz(src.pitch), pointer: `${base}/pitch` },
      ...(layer.pitchEnv ?? []).map((p, j) => ({ hz: noteToHz(p.to), pointer: `/layers/${i}/pitchEnv/${j}/to` }))];
    for (const p of pitches) for (const q of ratios) {
      // Point at the ratio when the ratio is what pushes past the limit; at the pitch otherwise.
      out.push({ hz: p.hz * q.r, pointer: q.pointer && q.r > 1 ? q.pointer : p.pointer });
    }
  });
  return out;
}

/** Layers that typically leave DC: brown or pink noise not high- or band-passed, and pitched layers reaching below 120 Hz with no highpass. */
function dcSuspects(patch: Patch): number[] {
  const out: number[] = [];
  patch.layers.forEach((layer, i) => {
    const src = layer.source, ft = layer.filter?.type;
    if (src.type === 'voice') return; // every output is a bandpass: no DC
    if (src.type === 'noise') { if (src.color !== 'white' && ft !== 'highpass' && ft !== 'bandpass') out.push(i); return; }
    if (!('pitch' in src) || src.type === 'modal' || ft === 'highpass' || ft === 'bandpass') return;
    const lowest = Math.min(noteToHz(src.pitch), ...(layer.pitchEnv ?? []).map(p => noteToHz(p.to)));
    if (lowest < 120) out.push(i);
  });
  return out;
}

/** Kit-level rules that lint (one patch at a time) cannot run. */
export const KIT_RULES = ['family-consistency', 'masking-risk', 'key-consistency', 'one-no', 'priority-levels'] as const;

/** An informational line in lint output: never an error or a warning, never changes the exit code. */
export interface Note { rule: string; message: string; name?: string }

/**
 * When a linted patch belongs to a set (it is in the kit, or other patches share its family), say that the set's rules
 * run only in `beeps kit check`, so an author checks them while drafting rather than at the end.
 */
export function kitRuleNotes(linted: Patch[], projectPatches: Patch[], kitNames: string[]): Note[] {
  const kit = new Set(kitNames);
  const all = new Map<string, Patch>();
  for (const p of [...projectPatches, ...linted]) all.set(p.name, p);
  const inKit = linted.filter(p => kit.has(p.name)).map(p => p.name);
  const families = new Map<string, string[]>();
  for (const p of linted) {
    const others = [...all.values()].filter(o => o.family === p.family && o.name !== p.name).map(o => o.name);
    if (others.length) families.set(p.family, [...new Set([...(families.get(p.family) ?? []), ...others, p.name])].sort());
  }
  if (!inKit.length && !families.size) return [];
  const toAdd = [...new Set([...families.values()].flat())].filter(n => !kit.has(n)).sort();
  const parts = [
    ...(inKit.length ? [`${inKit.join(', ')} ${inKit.length === 1 ? 'is' : 'are'} in the kit`] : []),
    ...[...families].map(([f, names]) => `family "${f}" has ${names.length} patches (${names.join(', ')})`),
  ];
  const next = toAdd.length ? `run beeps kit add <name> for each of ${toAdd.join(', ')}, then beeps kit check` : 'run beeps kit check';
  return [{ rule: 'kit-rules', message: `kit-level rules (${KIT_RULES.join(', ')}) run only in beeps kit check, not in lint: ${parts.join('; ')}. While authoring the set, ${next}.` }];
}

/** A render this much longer than its audible part (within 40 dB of peak) is mostly near-silent effect tail. */
export const EFFECT_TAIL_NOTE_SEC = 0.2;

/**
 * tail-ceiling measures to 60 dB below peak, so a quiet reverb or delay tail passes it while the exported WAV still carries
 * it. Say how much of the render is that tail and how to drop it at export.
 */
export function effectTailNotes(patch: Patch, features: Features): Note[] {
  if (!patch.fx?.reverb && !patch.fx?.delay) return [];
  const quiet = Math.round((features.durationSec - features.energyLengthSec) * 1000) / 1000;
  if (!(quiet >= EFFECT_TAIL_NOTE_SEC)) return [];
  return [{ rule: 'effect-tail', name: patch.name, message: `${quiet} s of the ${features.durationSec} s render is more than 40 dB below peak (a ${patch.fx.reverb ? 'reverb' : 'delay'} tail); tail-ceiling (to -60 dB below peak) can pass it while the WAV still carries it. beeps export --trim-tail -60 drops what is below -60 dBFS; a shorter or quieter send shortens it at the source` }];
}

function tailCeiling(table: Record<string, number>, family: string): number {
  if (family in table) return table[family];
  if (family.startsWith('ui-') && 'ui-*' in table) return table['ui-*'];
  return table.default;
}

/** What a patch's lint can know about the other patches around it. */
export interface PatchContext {
  /** Names of the patch's sibling variants (see variantSiblings). */
  siblings?: string[];
}

/** The sibling group of a patch: meta.variantOf, else the stem of a `<stem>-<n>` name; always within one family. */
export function siblingKey(patch: Patch): string | undefined {
  const stem = patch.meta?.variantOf ?? /^(.+)-\d+$/.exec(patch.name)?.[1];
  return stem === undefined ? undefined : `${patch.family}/${stem}`;
}

/** For every patch name, the other patches in its sibling group (hand-made variants authored as separate patches). */
export function variantSiblings(patches: Patch[]): Map<string, string[]> {
  const groups = new Map<string, Set<string>>();
  for (const p of patches) {
    const k = siblingKey(p);
    if (k !== undefined) groups.set(k, (groups.get(k) ?? new Set()).add(p.name));
  }
  const out = new Map<string, string[]>();
  for (const p of patches) {
    const k = siblingKey(p);
    out.set(p.name, k === undefined ? [] : [...groups.get(k)!].filter(n => n !== p.name).sort());
  }
  return out;
}

export function lintPatch(patch: Patch, features: Features, project: Project, rules = loadRules(), context: PatchContext = {}): LintReport {
  const c = new Collector(rules);
  const d = features.delivered;
  const intent = patch.meta?.intent ?? 'oneshot';

  const tp = c.num('true-peak-ceiling');
  if (d.truePeakDb > tp + c.param<number>('true-peak-ceiling', 'toleranceDb')) {
    c.add('true-peak-ceiling', `delivered true peak ${d.truePeakDb} dBTP is above the ${tp} dBTP ceiling`);
  }
  if (d.clippedSamples > c.num('no-clipping')) c.add('no-clipping', `delivered sound has ${d.clippedSamples} clipped samples`);

  const dc = c.num('no-dc');
  if (Math.abs(features.dcOffset) >= dc) {
    const suspects = dcSuspects(patch);
    const fixes = ['a highpass at 45-50 Hz (resonanceDb 0) on a low sine, triangle or FM thump', 'bandpass instead of lowpass on brown or pink noise bodies', 'the thump at gainDb -4 to -5',
      ...(patch.fx?.dcBlock ? [] : ['or fx.dcBlock: true (a 10 Hz DC blocker on the layer mix)'])];
    c.add('no-dc', `DC offset ${features.dcOffset} is at or above ${dc} of full scale${suspects.length ? ` (likely layers: ${suspects.join(', ')})` : ''}; fixes that work: ${fixes.join('; ')}`, suspects.length ? `/layers/${suspects[0]}` : undefined);
  }

  if (intent !== 'click') {
    const floor = c.num('attack-floor');
    const quiet = c.param<number>('attack-floor', 'quietLayerGainDb');
    patch.layers.forEach((layer, i) => {
      if (layer.amp.attack < floor && layer.gainDb > quiet) {
        c.add('attack-floor', `layer ${i} attack ${layer.amp.attack} s is under ${floor} s (clicks at onset); lengthen it, lower the layer to gainDb ${quiet} or below, or set meta.intent to "click"`, `/layers/${i}/amp/attack`);
      }
    });
    const measuredMin = c.param<number>('attack-floor', 'measuredMinSec');
    if (features.attackSec < measuredMin) {
      c.add('attack-floor', `measured attack ${features.attackSec} s is under ${measuredMin} s`);
    }
  }

  const limit = c.num('nyquist') * project.sampleRate;
  for (const f of declaredFrequencies(patch)) {
    if (f.hz >= limit) c.add('nyquist', `declared frequency ${fmt(f.hz, 0)} Hz is at or above ${fmt(limit, 0)} Hz (0.45 x sample rate) and will alias or be dropped`, f.pointer);
  }

  if (c.param<string[]>('tick-length', 'families').includes(patch.family)) {
    const max = c.num('tick-length');
    if (features.energyLengthSec > max) c.add('tick-length', `${patch.family} energy length ${features.energyLengthSec} s exceeds ${max} s; shorten decay and release`, '/layers');
  }

  const table = c.rule('tail-ceiling').value;
  if (table && typeof table === 'object') {
    const max = tailCeiling(table, patch.family);
    if (features.tailSec > max) c.add('tail-ceiling', `tail ${features.tailSec} s exceeds the ${max} s ceiling for family "${patch.family}" (${features.energyLengthSec} s within 40 dB of peak is what is heard); shorten the release or the reverb/delay, or export with --trim-tail -60 to drop the near-silent end`);
  }

  const sharp = c.num('sharpness-warn');
  if (features.sharpness > sharp && !patch.tags.includes(c.param<string>('sharpness-warn', 'exemptTag'))) {
    c.add('sharpness-warn', `sharpness ${features.sharpness} acum is above ${sharp}; darken it, or tag the patch "bright" if that is the point`);
  }
  const rough = c.num('roughness-warn');
  if (features.roughness > rough && !patch.tags.includes(c.param<string>('roughness-warn', 'exemptTag'))) {
    c.add('roughness-warn', `roughness ${features.roughness} asper is above ${rough}; separate beating partials, or tag the patch "gritty" if that is the point`);
  }

  if (patch.tags.includes('repeating')) {
    const minVariants = c.num('variation-on-repeating');
    const minCents = c.param<number>('variation-on-repeating', 'minPitchCents');
    const v = patch.variation;
    const siblings = context.siblings?.length ?? 0;
    // Hand-made variants authored as separate patches count: the patch and its siblings are the permutations.
    if ((!v || (v.variants < minVariants && v.pitchCents < minCents)) && 1 + siblings < minVariants) {
      c.add('variation-on-repeating', `patch is tagged "repeating" but declares ${v?.variants ?? 1} variant(s) and ${v?.pitchCents ?? 0} cents of pitch spread, and has ${siblings} sibling patch(es); declare variants >= ${minVariants} or pitchCents >= ${minCents}, or author ${minVariants}+ sibling patches in one family (names <stem>-<n>, or the same meta.variantOf)`, '/variation');
    }
  }

  const target = targetFor(patch, project);
  const tol = c.num('loudness-target');
  const quietByPeak = d.peakLimited && d.momentaryMaxLufs < target; // trimmed down to keep peaks clean: allowed
  if (!quietByPeak && !(Math.abs(d.momentaryMaxLufs - target) <= tol)) {
    c.add('loudness-target', `delivered max momentary loudness ${d.momentaryMaxLufs} LUFS is not within ${tol} LU of the ${target} LUFS target`);
  }

  const presets = ['small', 'room', 'hall', 'cave'];
  if (patch.fx?.reverb && !presets.includes(patch.fx.reverb.preset)) {
    c.add('reverb-preset-only', `reverb preset "${patch.fx.reverb.preset}" is not one of ${presets.join(', ')}`, '/fx/reverb/preset');
  }

  return c.report('patch', rules);
}

const pitched = (f: Features) => f.pitchStrength >= 0.7 && f.pitchHz > 0;
const argmax = (xs: number[]) => xs.reduce((best, x, i) => (x > xs[best] ? i : best), 0);

export function lintKit(members: KitMember[], project: Project, rules = loadRules()): LintReport {
  const c = new Collector(rules);

  const nos = members.filter(m => m.patch.family === 'no');
  if (nos.length > 1) c.add('one-no', `kit has ${nos.length} sounds in family "no" (${nos.map(m => m.patch.name).join(', ')}); keep one so every refusal sounds the same`);
  else if (nos.length === 0) c.add('one-no', 'kit has no sound in family "no"; every refusal needs the same one', undefined, 'warn');

  const levels = [...new Set(members.map(m => m.priority))].sort((a, b) => a - b);
  const maxLevels = c.num('priority-levels');
  if (levels.length > maxLevels) c.add('priority-levels', `kit uses ${levels.length} priority levels (${levels.join(', ')}); use at most ${maxLevels}`);

  const maxOctaves = c.num('family-consistency');
  const families = new Map<string, KitMember[]>();
  for (const m of members) families.set(m.patch.family, [...(families.get(m.patch.family) ?? []), m]);
  for (const [family, group] of families) {
    if (group.length < 2) continue;
    const cs = group.map(m => m.features.centroidHz).filter(x => x > 0);
    if (cs.length < 2) continue;
    const span = Math.log2(Math.max(...cs) / Math.min(...cs));
    if (span > maxOctaves) {
      c.add('family-consistency', `family "${family}" centroids span ${fmt(span, 2)} octaves (${group.map(m => `${m.patch.name} ${m.features.centroidHz} Hz`).join(', ')}); keep within ${maxOctaves}`);
    }
  }

  const maxCents = c.num('key-consistency');
  for (const m of members) {
    if (!pitched(m.features)) continue;
    const snapped = snapToScale(m.features.pitchHz, project.scale);
    const cents = 100 * Math.abs(hzToMidi(m.features.pitchHz) - hzToMidi(snapped));
    if (cents > maxCents) {
      c.add('key-consistency', `${m.patch.name} pitch ${m.features.pitchHz} Hz is ${fmt(cents, 0)} cents from the nearest ${project.scale.root} ${project.scale.mode} pitch (${fmt(snapped, 1)} Hz)`);
    }
  }

  const maxRatio = c.num('masking-risk');
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
    const a = members[i].features, b = members[j].features;
    if (!a.bands.length || !b.bands.length || !(a.centroidHz > 0 && b.centroidHz > 0)) continue;
    if (argmax(a.bands) !== argmax(b.bands)) continue;
    const ratio = Math.max(a.centroidHz, b.centroidHz) / Math.min(a.centroidHz, b.centroidHz);
    if (ratio < maxRatio) {
      c.add('masking-risk', `${members[i].patch.name} and ${members[j].patch.name} share a dominant band and their centroids are ${fmt(ratio, 3)}x apart (under ${fmt(maxRatio, 3)}x); move one by register if they can sound together`);
    }
  }

  return c.report('kit', rules);
}
