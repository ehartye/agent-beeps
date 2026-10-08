import { z } from 'zod';
import { parseChord } from '../../runtime/engine/chords.js';
import { expandEuclid } from '../../runtime/engine/sequence.js';
import { parsePatch, pointerOf, REVERB_PRESET_NAMES, type Issue, type Patch } from './patch.ts';

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const Name = z.string().regex(NAME, 'lowercase letters, digits and dashes');
const Note = z.string().regex(/^[A-G](#|b)?-?\d$/, 'notes in songs are names like A4, F#3 or Bb2');
/**
 * Step strings: X accent, x hit, o ghost, . rest, _ hold the previous hit; spaces and | are ignored.
 * A euclidean token glyph(hits,steps[,rotation]) such as x(3,8) spells out an even spread of hits.
 */
const STEPS_HINT = 'steps use X (accent) x (hit) o (ghost) ? (hit half the time) . (rest) _ (hold), or euclidean x(3,8) / X(5,16,2) (hits, steps, rotation); spaces and | are ignored';
const STEPS_GRAMMAR = /^(?:[Xxo?._|\s]|[Xxo?]\(\d{1,3},\d{1,3}(?:,\d{1,3})?\))+$/;
// The regex publishes the grammar in the JSON schema; the refinement checks counts and hits.
const Steps = z.string().regex(STEPS_GRAMMAR, STEPS_HINT).superRefine((s, ctx) => {
  if (!STEPS_GRAMMAR.test(s)) return; // already reported by the regex
  let flat: string;
  try { flat = expandEuclid(s); } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); return; }
  if (!/[Xxo?]/.test(flat)) ctx.addIssue({ code: 'custom', message: 'a step string needs at least one hit' });
}).describe(STEPS_HINT);
const Octave = z.number().int().min(0).max(8).describe('octave the chord/bass root lands in (C4 = middle C; bass usually 2). spread voicing puts the root one octave lower');
const Gate = z.union([z.number().min(0.05).max(4), z.literal('patch')]);

const Track = z.strictObject({
  /** A name (song instruments, project patches, then the library), an inline patch (schema/name/family may be omitted), or {base, set} overrides of a named instrument. */
  instrument: z.union([Name, z.record(z.string(), z.unknown())]).describe('instrument name, inline patch, or {"base": name, "set": {"/json/pointer": value}}'),
  gainDb: z.number().min(-60).max(12).default(0),
  pan: z.number().min(-1).max(1).default(0),
  /** Track lowpass in Hz; sections can move it. */
  cutoff: z.number().min(20).max(20000).optional(),
  sends: z.strictObject({ reverb: z.number().min(-60).max(0).optional(), delay: z.number().min(-60).max(0).optional() }).default({}),
  /** 0: filters stay put as notes move; 1: cutoffs follow pitch exactly. */
  keytrack: z.number().min(0).max(1).default(0),
  /** The note the instrument patch sounds at as written (default: its first pitched layer). */
  root: Note.optional(),
  /** Semitones added to every note this track plays (the instrument sounds this far above the written note). */
  transpose: z.number().min(-48).max(48).optional().describe('semitones the instrument sounds above the written note (default 0)'),
  /** true: the instrument always sounds at its own pitch (plus transpose); written notes only time the hits. */
  fixed: z.boolean().optional().describe('true: play the instrument at its own pitch whatever note is written; the notes only time the hits'),
  /** Seeded timing (up to 12 ms) and velocity (up to ±20%) looseness. */
  humanize: z.number().min(0).max(1).default(0),
  /** Stereo spread for chords: voices fan out across ±spread. */
  spread: z.number().min(0).max(1).default(0),
  /** Swing for this track only (overrides the song's). */
  swing: z.number().min(0).max(0.75).optional(),
  /** Track highpass in Hz: trims an instrument's low layers without editing the patch. */
  highpass: z.number().min(20).max(20000).optional(),
});

const ProgRef = z.string();
const Chords = z.strictObject({
  progression: ProgRef,
  octave: Octave.default(4),
  voicing: z.enum(['lead', 'spread', 'close', 'drop2', 'open']).default('lead'),
  /** false: leave a slash chord's bass note to the bass part. */
  slash: z.boolean().default(true),
  /** Restrike rhythm over each chord; default holds the chord for its full length. */
  rhythm: Steps.optional(),
  /** Seconds between successive chord tones, low to high. */
  strum: z.number().min(0).max(0.2).default(0),
});
const Arp = z.strictObject({
  progression: ProgRef,
  /** Notes per beat. */
  rate: z.number().min(0.25).max(8).default(2).describe('arp notes per beat (2 = eighths, 4 = sixteenths)'),
  shape: z.enum(['up', 'down', 'updown', 'random', 'converge']).default('up'),
  /** true: include a slash chord's bass note in the arp (off by default: it drops into the bass band). */
  slash: z.boolean().default(false),
  octaves: z.number().int().min(1).max(4).default(1),
  octave: Octave.default(4),
  /** Optional rhythm mask per arp step (same stepsPerBeat as rate). */
  rhythm: Steps.optional(),
});
const Bass = z.strictObject({
  progression: ProgRef,
  octave: Octave.default(2),
  /** Step rhythm per chord (4 steps per beat); default holds the root for the chord. */
  rhythm: Steps.optional(),
  /** Chord-tone indices cycled per hit: 0 root, 1 third, 2 fifth... (the slash bass replaces 0). */
  tones: z.array(z.number().int().min(0).max(6)).min(1).default([0]).describe('chord-tone index per hit, cycled: 0 root (slash bass if any), 1 third, 2 fifth, 3 seventh'),
});
const NoteEvent = z.tuple([z.number().min(0), Note, z.number().positive().max(64)]).rest(z.number().min(0).max(1)).describe('[start beat from the pattern start, note name, length in beats, velocity 0-1 (default 1)]');

const Pattern = z.strictObject({
  bars: z.number().min(0.25).max(64).describe('pattern length in bars; it repeats to fill each section that plays it'),
  /** Held notes last length × gate; "patch" lets the instrument's own duration decide (drums). */
  gate: Gate.optional(),
  transpose: z.number().int().min(-36).max(36).default(0),
  /** Velocity scale for the whole pattern. */
  vel: z.number().min(0).max(1).default(1),
  notes: z.array(NoteEvent).optional(),
  chords: Chords.optional(),
  arp: Arp.optional(),
  bass: Bass.optional(),
  steps: Steps.optional(),
  stepsPerBeat: z.number().int().min(1).max(8).default(4),
  /** How long each rhythm hit lasts, in beats (default one step); _ holds add steps to it. */
  hitBeats: z.number().positive().max(16).optional(),
  /** The note step hits play (default: the instrument's root, untransposed). */
  note: Note.optional(),
});

const MixValues = {
  gainDb: z.number().min(-60).max(12).optional(),
  cutoff: z.number().min(20).max(20000).optional(),
  pan: z.number().min(-1).max(1).optional(),
  sends: z.strictObject({ reverb: z.number().min(-60).max(0).optional(), delay: z.number().min(-60).max(0).optional() }).optional(),
};
const MixPoint = z.strictObject({
  ...MixValues,
  /** Where the move starts, when it should not start from the current value (a fade-in from near silence). */
  from: z.strictObject(MixValues).optional(),
});
/** true: glide across the whole section; {bars, at}: glide over its first or last bars (fade-ins, outros). */
const Ramp = z.union([z.boolean(), z.strictObject({ bars: z.number().positive().max(256), at: z.enum(['start', 'end']).default('end') })]);
const Section = z.strictObject({
  bars: z.number().min(0.25).max(256),
  play: z.record(z.string(), z.union([z.string(), z.array(z.string()).min(1), z.null()])).describe('track name -> pattern name, a list of patterns played in turn, or null; unlisted tracks are silent'),
  /** Track levels/cutoffs from this section on; with ramp they glide across the section. */
  mix: z.record(z.string(), MixPoint).optional(),
  ramp: Ramp.default(false),
  /** "section": mix values return to what they were when the section ends; "song" (default): they persist. */
  mixScope: z.enum(['song', 'section']).default('song'),
});

/** Vertical layers a game fades in and out by state: every track in one layer, states name layers. */
const Adaptive = z.strictObject({
  layers: z.record(Name, z.array(z.string()).min(1)).describe('layer name -> the tracks it contains; every track is in exactly one layer'),
  states: z.record(Name, z.array(z.string()).min(1)).describe('state name -> the layers that play in it'),
  initial: Name.describe('the state the song starts in'),
}).describe('adaptive vertical layers for the game player; needs loop: true');

export const SongSchema = z.strictObject({
  schema: z.literal('beeps/song@1'),
  name: Name,
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  bpm: z.number().min(30).max(240).describe('quarter-note beats per minute'),
  meter: z.number().int().min(2).max(12).default(4).describe('beats per bar'),
  /** Delays every off-beat sixteenth by this fraction of a sixteenth. */
  swing: z.number().min(0).max(0.75).default(0),
  /** Fold the tail onto the start so the render loops seamlessly. */
  loop: z.boolean().default(false),
  seed: z.number().int().min(0).default(1),
  /** Instruments this song defines once and its tracks name: inline patches or {base, set} overrides. */
  instruments: z.record(Name, z.record(z.string(), z.unknown())).default({}).describe('instrument name -> inline patch or {"base": name, "set": {"/json/pointer": value}}; tracks name them like library instruments'),
  progressions: z.record(Name, z.array(z.tuple([z.string(), z.number().positive().max(64)]).describe('[chord symbol such as Dm9 or C/E, length in beats]')).min(1)).default({}).describe('named chord sequences that chords, arp and bass patterns read; they cycle to fill the pattern'),
  tracks: z.record(Name, Track),
  patterns: z.record(Name, Pattern),
  sections: z.record(Name, Section),
  form: z.array(z.string()).min(1).max(64).describe('section names in play order'),
  master: z.strictObject({
    reverb: z.strictObject({ preset: z.enum(REVERB_PRESET_NAMES), returnDb: z.number().min(-40).max(6).default(0) }).optional(),
    delay: z.strictObject({ beats: z.number().min(0.0625).max(4), feedback: z.number().min(0).max(0.9).default(0.35), returnDb: z.number().min(-40).max(6).default(0), cutoff: z.number().min(200).max(20000).default(4000) }).optional(),
  }).default({}),
  adaptive: Adaptive.optional(),
});

export type Song = z.output<typeof SongSchema>;
export type SongPattern = Song['patterns'][string];
export type SongTrack = Song['tracks'][string];
export type SongResult = { ok: true; song: Song } | { ok: false; issues: Issue[] };

const PATTERN_KINDS = ['notes', 'chords', 'arp', 'bass', 'steps'] as const;

/** Fill what an inline instrument may leave out, so a track can hold a bare { layers, duration }. */
export function inlinePatchInput(track: string, raw: Record<string, unknown>): Record<string, unknown> {
  return { schema: 'beeps/patch@1', name: track, family: 'music', duration: 1, ...raw };
}

/** {base, set}: a named instrument with JSON-pointer overrides, rather than a whole inline patch. */
export const isOverride = (x: unknown): x is { base: string; set?: Record<string, unknown> } =>
  !!x && typeof x === 'object' && typeof (x as { base?: unknown }).base === 'string' && !('layers' in (x as object));

/** References and musical content zod cannot see: progressions, patterns, sections, chords. */
function crossCheck(s: Song): Issue[] {
  const out: Issue[] = [];
  const at = (...path: (string | number)[]) => pointerOf(path);
  for (const [name, prog] of Object.entries(s.progressions)) prog.forEach(([sym], i) => {
    try { parseChord(sym); } catch (e) { out.push({ pointer: at('progressions', name, i, 0), message: (e as Error).message, hint: 'chords look like Dm9, Bbmaj7, C6/9, F#m7b5, Gsus4 or C/E' }); }
  });
  for (const [name, p] of Object.entries(s.patterns)) {
    const kinds = PATTERN_KINDS.filter(k => p[k] !== undefined);
    if (kinds.length !== 1) { out.push({ pointer: at('patterns', name), message: `a pattern needs exactly one of ${PATTERN_KINDS.join(', ')} (found ${kinds.join(', ') || 'none'})` }); continue; }
    const kind = kinds[0];
    if (kind === 'chords' || kind === 'arp' || kind === 'bass') {
      const ref = p[kind]!.progression;
      if (!(ref in s.progressions)) out.push({ pointer: at('patterns', name, kind, 'progression'), message: `no progression "${ref}"`, hint: `progressions: ${Object.keys(s.progressions).join(', ') || '(none defined)'}` });
    }
    if (kind === 'notes') p.notes!.forEach((n, i) => { if (n[0] >= p.bars * s.meter) out.push({ pointer: at('patterns', name, 'notes', i, 0), message: `beat ${n[0]} is past the pattern's ${p.bars * s.meter} beats` }); });
  }
  for (const [name, sec] of Object.entries(s.sections)) {
    for (const [track, ref] of Object.entries(sec.play)) {
      if (!(track in s.tracks)) { out.push({ pointer: at('sections', name, 'play', track), message: `no track "${track}"`, hint: `tracks: ${Object.keys(s.tracks).join(', ')}` }); continue; }
      for (const r of ref === null ? [] : Array.isArray(ref) ? ref : [ref]) {
        if (!(r in s.patterns)) out.push({ pointer: at('sections', name, 'play', track), message: `no pattern "${r}"`, hint: `patterns: ${Object.keys(s.patterns).join(', ')}` });
      }
    }
    for (const track of Object.keys(sec.mix ?? {})) if (!(track in s.tracks)) out.push({ pointer: at('sections', name, 'mix', track), message: `no track "${track}"` });
  }
  s.form.forEach((f, i) => { if (!(f in s.sections)) out.push({ pointer: at('form', i), message: `no section "${f}"`, hint: `sections: ${Object.keys(s.sections).join(', ')}` }); });
  if (s.adaptive) {
    const a = s.adaptive;
    if (!s.loop) out.push({ pointer: at('adaptive'), message: 'adaptive layers need "loop": true', hint: 'layers loop under gameplay; set "loop": true' });
    const owner = new Map<string, string>();
    for (const [layer, tracks] of Object.entries(a.layers)) {
      const seen = new Set<string>();
      tracks.forEach((t, i) => {
        if (!Object.hasOwn(s.tracks, t)) { out.push({ pointer: at('adaptive', 'layers', layer, i), message: `no track "${t}"`, hint: `tracks: ${Object.keys(s.tracks).join(', ')}` }); return; }
        if (seen.has(t)) { out.push({ pointer: at('adaptive', 'layers', layer, i), message: `track "${t}" is listed twice in layer "${layer}"`, hint: 'every track belongs to exactly one layer' }); return; }
        seen.add(t);
        if (owner.has(t)) { out.push({ pointer: at('adaptive', 'layers', layer, i), message: `track "${t}" is already in layer "${owner.get(t)}"`, hint: 'every track belongs to exactly one layer' }); return; }
        owner.set(t, layer);
      });
    }
    for (const t of Object.keys(s.tracks)) if (!owner.has(t)) out.push({ pointer: at('adaptive', 'layers'), message: `track "${t}" is in no layer`, hint: 'every track belongs to exactly one layer' });
    for (const [state, layers] of Object.entries(a.states)) {
      const seen = new Set<string>();
      layers.forEach((l, i) => {
        if (!Object.hasOwn(a.layers, l)) { out.push({ pointer: at('adaptive', 'states', state, i), message: `no layer "${l}"`, hint: `layers: ${Object.keys(a.layers).join(', ') || '(none defined)'}` }); return; }
        if (seen.has(l)) { out.push({ pointer: at('adaptive', 'states', state, i), message: `layer "${l}" is listed twice in state "${state}"`, hint: 'each layer plays once in a state' }); return; }
        seen.add(l);
      });
    }
    if (!Object.hasOwn(a.states, a.initial)) out.push({ pointer: at('adaptive', 'initial'), message: `no state "${a.initial}"`, hint: `states: ${Object.keys(a.states).join(', ') || '(none defined)'}` });
  }
  // Inline patches validate here; names and {base, set} overrides resolve against the project at render time.
  const inline = [
    ...Object.entries(s.instruments).map(([name, x]) => ({ name, x, where: at('instruments', name) })),
    ...Object.entries(s.tracks).flatMap(([name, t]) => (typeof t.instrument === 'string' ? [] : [{ name, x: t.instrument, where: at('tracks', name, 'instrument') }])),
  ];
  for (const { name, x, where } of inline) {
    if (isOverride(x)) continue;
    const r = parsePatch(inlinePatchInput(name, x));
    if (!r.ok) out.push(...r.issues.map(i => ({ ...i, pointer: where + i.pointer })));
  }
  return out;
}

export function parseSong(input: unknown): SongResult {
  const r = SongSchema.safeParse(input);
  if (!r.success) {
    return { ok: false, issues: r.error.issues.map(i => ({ pointer: pointerOf(i.path), message: i.message, ...(i.path.includes('instrument') ? { hint: 'an instrument is a patch name or an inline patch object' } : {}) })) };
  }
  const issues = crossCheck(r.data);
  return issues.length ? { ok: false, issues } : { ok: true, song: r.data };
}

export function songJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(SongSchema, { io: 'input' }) as Record<string, unknown>;
}
