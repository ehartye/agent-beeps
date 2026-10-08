// Craft lint for songs: craft/music-rules.json applied to a song's declaration and measured features.
import { join } from 'node:path';
import { Collector, loadRules, RULES_PATH, type LintReport } from './lint.ts';
import type { SongFeatures } from './measure/song.ts';
import type { Song } from './schema/song.ts';
import type { Project } from './schema/project.ts';
import { compileSong } from '../runtime/engine/sequence.js';
import { hzToMidi, noteToHz } from '../runtime/engine/notes.js';
import { instrumentRoot, instrumentSpan, trackShift } from '../runtime/engine/song.js';
import type { Patch } from './schema/patch.ts';

export const MUSIC_RULES_PATH = join(RULES_PATH, '..', 'music-rules.json');

/**
 * Where each track's written notes actually sound (the pitch of the instrument's root layer): the
 * note itself, unless the track sets `root`, `transpose` or `fixed`. Null for a track with an
 * unpitched or unknown instrument.
 */
export function soundingPitch(song: Song, instruments: Record<string, Patch>): Record<string, (midi: number) => number> {
  const out: Record<string, (midi: number) => number> = {};
  for (const [name, t] of Object.entries(song.tracks)) {
    const p = instruments[name], inst = p && instrumentRoot(p), shift = p && trackShift(t, p);
    if (inst === null || inst === undefined || !shift) continue;
    out[name] = t.root === undefined && t.transpose === undefined && !t.fixed ? m => m : m => inst + shift(m);
  }
  return out;
}

const fmt = (x: number, d = 1) => String(Math.round(x * 10 ** d) / 10 ** d);

/**
 * `instruments` (per track) lets the register check use what actually sounds: a note played by a
 * pad with a sub-octave layer reaches an octave lower than the note written.
 */
export function lintSong(song: Song, f: SongFeatures, project: Project, instruments: Record<string, Patch> = {}): LintReport & { judgementChecks: { rule: string; check: string; data?: { section: string; overlaps: string[] }[] }[] } {
  const rules = loadRules(MUSIC_RULES_PATH);
  const c = new Collector(rules);
  const range = (id: string) => c.rule(id).value as Record<string, number>;
  const d = f.delivered;

  if (d) {
    const tp = c.num('song-true-peak');
    if (d.truePeakDb > tp + c.param<number>('song-true-peak', 'toleranceDb')) c.add('song-true-peak', `true peak ${fmt(d.truePeakDb)} dBTP is over ${tp}`);
    if (d.clippedSamples > c.num('song-no-clipping')) c.add('song-no-clipping', `${d.clippedSamples} clipped samples`);
    const off = d.integratedLufs - project.musicLoudness;
    if (Math.abs(off) > c.num('song-loudness-target')) {
      c.add('song-loudness-target', d.peakLimited
        ? `plays at ${fmt(d.integratedLufs)} LUFS, ${fmt(-off)} LU under target: transients cap the level (crest ${fmt(f.crestDb)} dB). Soften drum accents or lower the peakiest track`
        : `plays at ${fmt(d.integratedLufs)} LUFS against a ${project.musicLoudness} target`);
    }
  }
  const lra = range('song-loudness-range');
  if (f.loudnessRangeLu > lra.max) c.add('song-loudness-range', `loudness range ${fmt(f.loudnessRangeLu)} LU: quiet passages will vanish under play`);
  else if (f.durationSec > c.param<number>('song-loudness-range', 'minAppliesAboveSec') && f.loudnessRangeLu < lra.min) {
    c.add('song-loudness-range', `loudness range ${fmt(f.loudnessRangeLu)} LU over ${fmt(f.durationSec, 0)} s: sections do not rise and fall; thin or drop parts in some sections`);
  }
  if (song.loop) {
    if (f.seamDb !== undefined && f.seamDb > c.num('song-loop-seam')) c.add('song-loop-seam', `level steps ${fmt(f.seamDb)} dB at the loop point (last 1.5 s ${fmt(f.seamEndLufs ?? NaN)} LUFS, first 1.5 s ${fmt(f.seamStartLufs ?? NaN)} LUFS): ${(f.seamEndLufs ?? 0) > (f.seamStartLufs ?? 0) ? 'the ending is denser than the opening' : 'the opening is denser than the ending'}; match them`, '/form');
    if (f.seam && f.seam.boundaryStepDb > c.num('song-loop-boundary-step')) c.add('song-loop-boundary-step', `the sample step across the loop point is ${fmt(f.seam.boundaryStepDb)} dB over a typical step (slope jump ${fmt(f.seam.slopeJumpDb)} dB): a tick on restart unless the loop starts on a transient by design`, '/form');
    const len = range('song-loop-length');
    const long = song.tags.some(t => c.param<string[]>('song-loop-length', 'longTags').includes(t));
    const min = long ? len.long : len.short;
    if (f.durationSec < min) c.add('song-loop-length', `a ${fmt(f.durationSec, 0)} s loop${long ? ` tagged ${song.tags.join(', ')}` : ''} repeats too soon (at least ${min} s)`, '/form');
  }
  const low = range('song-low-end');
  if (f.lowShare > low.max) c.add('song-low-end', `${fmt(100 * f.lowShare, 0)}% of energy is below 120 Hz: bass or kick masks the mix`);
  // An ambience bed (tag "ambience") sits under music and sound effects on purpose: wind and rain have no bass to be thin about.
  else if (f.lowShare < low.min && !song.tags.includes('ambience')) c.add('song-low-end', `only ${fmt(100 * f.lowShare, 1)}% of energy below 120 Hz: thin`);

  const reg = range('song-register');
  const spans = Object.fromEntries(Object.entries(instruments).map(([t, p]) => [t, instrumentSpan(p)]));
  const outside = new Map<string, { lo: number; hi: number; layer: boolean }>();
  const sounding = soundingPitch(song, instruments);
  const compiled = compileSong(song);
  for (const e of compiled.events) {
    // An instrument with no pitched layer (null span) does not sound its trigger note.
    if (e.midi === null || spans[e.track] === null) continue;
    const span = spans[e.track];
    const at = sounding[e.track]?.(e.midi) ?? e.midi;
    const lo = at + (span?.low ?? 0), hi = at + (span?.high ?? 0);
    if (lo >= reg.lowestMidi && hi <= reg.highestMidi) continue;
    const o = outside.get(e.pattern) ?? { lo: Infinity, hi: -Infinity, layer: false };
    outside.set(e.pattern, { lo: Math.min(o.lo, lo), hi: Math.max(o.hi, hi), layer: o.layer || (lo < reg.lowestMidi && lo !== at) || (hi > reg.highestMidi && hi !== at) });
  }
  for (const [pattern, o] of outside) {
    const hz = (m: number) => fmt(440 * 2 ** ((m - 69) / 12), 0);
    const why = o.layer ? " (an instrument layer sounds below or above the written note: see 'beeps instruments' spans)" : '';
    c.add('song-register', o.lo < reg.lowestMidi ? `pattern "${pattern}" reaches ${hz(o.lo)} Hz (below E1)${why}: raise its octave` : `pattern "${pattern}" reaches ${hz(o.hi)} Hz (above C8)${why}: lower its octave`, `/patterns/${pattern}`);
  }

  // A pitched instrument is retuned to each written note: far from its root, its filters, envelopes
  // and layer balance (made for the root) stop matching the sound that plays.
  const far = c.num('song-written-pitch');
  for (const [track, t] of Object.entries(song.tracks)) {
    const p = instruments[track], inst = p && instrumentRoot(p);
    if (inst === null || inst === undefined || t.fixed) continue;
    const ref = t.root !== undefined ? hzToMidi(noteToHz(t.root)) : inst, tr = t.transpose ?? 0;
    const notes = compiled.events.filter(e => e.track === track && e.midi !== null).map(e => e.midi!);
    // How far the engine retunes the patch from the root it was built at.
    const worst = notes.map(m => m - ref + tr).reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    if (notes.length === 0 || Math.abs(worst) <= far) continue;
    const lo = Math.min(...notes), hi = Math.max(...notes), written = lo === hi ? nn(lo) : `${nn(lo)}-${nn(hi)}`;
    const hzOf = (m: number) => fmt(440 * 2 ** ((m - 69) / 12), 0);
    c.add('song-written-pitch', `track "${track}" writes ${written} for an instrument rooted at ${nn(inst)} (${hzOf(inst)} Hz): the whole patch is retuned ${fmt(Math.abs(worst), 0)} semitones ${worst > 0 ? 'up' : 'down'} and sounds at ${hzOf(inst + worst)} Hz. To play it as built at ${nn(inst)}, set "fixed": true on the track; to keep following the notes, set "root": "${nn((lo + hi) / 2)}" (the note it should sound at as written) or write notes near ${nn(ref)}`, `/tracks/${track}`);
  }

  const played = new Set<string>(), usedTracks = new Set<string>();
  for (const name of new Set(song.form)) for (const [track, ref] of Object.entries(song.sections[name].play)) {
    if (ref === null) continue;
    usedTracks.add(track);
    for (const r of Array.isArray(ref) ? ref : [ref]) played.add(r);
  }
  for (const t of Object.keys(song.tracks)) if (!usedTracks.has(t)) c.add('song-unused', `track "${t}" never plays`, `/tracks/${t}`);
  for (const p of Object.keys(song.patterns)) if (!played.has(p)) c.add('song-unused', `pattern "${p}" never plays`, `/patterns/${p}`);
  // Judgement rules come with their statements: a bare id is not a checklist. Listener fatigue is
  // about music heard for a long time, so a short one-shot (a jingle or sting) is out of its scope.
  const bands = registerOverlaps(song, spans, sounding);
  const heardLong = song.loop || f.durationSec > c.param<number>('song-fatigue', 'appliesToLoopsOrAboveSec');
  const inScope = rules.filter(r => (r.id !== 'song-fatigue' || heardLong) && (r.id !== 'song-adaptive-states' || !!song.adaptive));
  return {
    ...c.report('song', inScope),
    judgementChecks: inScope.filter(r => r.check === 'judgement' && r.appliesTo === 'song').map(r => ({
      rule: r.id, check: r.statement, ...(r.id === 'song-register-bands' && bands.length ? { data: bands } : {}),
    })),
  };
}

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const nn = (m: number) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

/**
 * Per section, register bands shared by concurrently held pitched notes. Sweep note and section
 * boundaries rather than combining pitches that play at different times. One-shot durations
 * (dur: null) and release/effect tails are unknown here; this is advisory, not spectral masking.
 * A null span marks an instrument with no pitched layer (noise, grains, metal): its trigger notes
 * are not sounding pitches, so the track is left out. Noise through a resonant keytracked filter
 * can still sound tonal; that case is not detected. An absent span (instrument unknown) keeps the
 * written note as the pitch.
 */
export function registerOverlaps(song: Song, spans: Record<string, { low: number; high: number } | null>, sounding: Record<string, (midi: number) => number> = {}) {
  const c = compileSong(song);
  type Range = { lo: number; hi: number };
  const events = c.events.filter(e => e.midi !== null && e.dur !== null && e.dur > 0 && e.vel > 0 && spans[e.track] !== null);
  const edges = events.flatMap((e, id) => [{ time: e.time, id, start: true }, { time: e.time + e.dur!, id, start: false }]);
  // Section boundaries split sustained notes even when no new note starts there.
  for (const sec of c.sections) edges.push({ time: sec.start, id: -1, start: false }, { time: sec.end, id: -1, start: false });
  edges.sort((a, b) => a.time - b.time);
  const active = new Set<number>();
  const found = new Map<string, Map<string, { tracks: string[]; ranges: Range[] }>>();
  const tracks = Object.keys(song.tracks);
  const merge = (a: Range, b: Range) => ({ lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) });
  let section = 0;
  for (let i = 0; i < edges.length;) {
    const time = edges[i].time;
    // Apply all changes before examining [time, next time): touching notes never coincide.
    while (i < edges.length && edges[i].time === time) {
      const edge = edges[i++];
      if (edge.id >= 0) { if (edge.start) active.add(edge.id); else active.delete(edge.id); }
    }
    while (section < c.sections.length && time >= c.sections[section].end) section++;
    if (section === c.sections.length) break;
    const sec = c.sections[section];
    // Equivalent beat boundaries can differ after seconds conversion and duration addition.
    // Ignore sub-nanosecond gaps, far below audio resolution, without hiding humanized overlaps.
    if (time < sec.start || i === edges.length || edges[i].time - time <= 1e-9) continue;
    const ranges = new Map<string, { lo: number; hi: number }>();
    for (const id of active) {
      const e = events[id];
      const sp = spans[e.track];
      const at = sounding[e.track]?.(e.midi!) ?? e.midi!;
      const r = { lo: at + (sp?.low ?? 0), hi: at + (sp?.high ?? 0) };
      ranges.set(e.track, merge(ranges.get(e.track) ?? r, r));
    }
    const playing = tracks.filter(t => ranges.has(t));
    for (let aIndex = 0; aIndex < playing.length; aIndex++) for (let bIndex = aIndex + 1; bIndex < playing.length; bIndex++) {
      const names = [playing[aIndex], playing[bIndex]];
      const a = ranges.get(names[0])!, b = ranges.get(names[1])!;
      const shared = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
      const narrow = Math.min(a.hi - a.lo, b.hi - b.lo);
      if (shared < Math.min(7, narrow)) continue;
      const pairs = found.get(sec.name) ?? new Map();
      const key = names.join('/'), previous = pairs.get(key);
      pairs.set(key, { tracks: names, ranges: previous ? [merge(previous.ranges[0], a), merge(previous.ranges[1], b)] : [a, b] });
      found.set(sec.name, pairs);
    }
  }
  const fmtRange = (r: Range) => (r.lo === r.hi ? nn(r.lo) : `${nn(r.lo)}-${nn(r.hi)}`);
  return [...found].map(([section, pairs]) => ({ section, overlaps: [...pairs.values()].map(p =>
    `${p.tracks[0]} ${fmtRange(p.ranges[0])} and ${p.tracks[1]} ${fmtRange(p.ranges[1])} share a band`) }));
}
