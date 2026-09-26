// Craft lint for songs: craft/music-rules.json applied to a song's declaration and measured features.
import { join } from 'node:path';
import { Collector, loadRules, RULES_PATH, type LintReport } from './lint.ts';
import type { SongFeatures } from './measure/song.ts';
import type { Song } from './schema/song.ts';
import type { Project } from './schema/project.ts';
import { compileSong } from '../runtime/engine/sequence.js';
import { instrumentSpan } from '../runtime/engine/song.js';
import type { Patch } from './schema/patch.ts';

export const MUSIC_RULES_PATH = join(RULES_PATH, '..', 'music-rules.json');

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
    const len = range('song-loop-length');
    const long = song.tags.some(t => c.param<string[]>('song-loop-length', 'longTags').includes(t));
    const min = long ? len.long : len.short;
    if (f.durationSec < min) c.add('song-loop-length', `a ${fmt(f.durationSec, 0)} s loop${long ? ` tagged ${song.tags.join(', ')}` : ''} repeats too soon (at least ${min} s)`, '/form');
  }
  const low = range('song-low-end');
  if (f.lowShare > low.max) c.add('song-low-end', `${fmt(100 * f.lowShare, 0)}% of energy is below 120 Hz: bass or kick masks the mix`);
  else if (f.lowShare < low.min) c.add('song-low-end', `only ${fmt(100 * f.lowShare, 1)}% of energy below 120 Hz: thin`);

  const reg = range('song-register');
  const spans = Object.fromEntries(Object.entries(instruments).map(([t, p]) => [t, instrumentSpan(p)]));
  const outside = new Map<string, { lo: number; hi: number; layer: boolean }>();
  for (const e of compileSong(song).events) {
    if (e.midi === null) continue;
    const span = spans[e.track];
    const lo = e.midi + (span?.low ?? 0), hi = e.midi + (span?.high ?? 0);
    if (lo >= reg.lowestMidi && hi <= reg.highestMidi) continue;
    const o = outside.get(e.pattern) ?? { lo: Infinity, hi: -Infinity, layer: false };
    outside.set(e.pattern, { lo: Math.min(o.lo, lo), hi: Math.max(o.hi, hi), layer: o.layer || (lo < reg.lowestMidi && lo !== e.midi) || (hi > reg.highestMidi && hi !== e.midi) });
  }
  for (const [pattern, o] of outside) {
    const hz = (m: number) => fmt(440 * 2 ** ((m - 69) / 12), 0);
    const why = o.layer ? " (an instrument layer sounds below or above the written note: see 'beeps instruments' spans)" : '';
    c.add('song-register', o.lo < reg.lowestMidi ? `pattern "${pattern}" reaches ${hz(o.lo)} Hz (below E1)${why}: raise its octave` : `pattern "${pattern}" reaches ${hz(o.hi)} Hz (above C8)${why}: lower its octave`, `/patterns/${pattern}`);
  }

  const played = new Set<string>(), usedTracks = new Set<string>();
  for (const name of new Set(song.form)) for (const [track, ref] of Object.entries(song.sections[name].play)) {
    if (ref === null) continue;
    usedTracks.add(track);
    for (const r of Array.isArray(ref) ? ref : [ref]) played.add(r);
  }
  for (const t of Object.keys(song.tracks)) if (!usedTracks.has(t)) c.add('song-unused', `track "${t}" never plays`, `/tracks/${t}`);
  for (const p of Object.keys(song.patterns)) if (!played.has(p)) c.add('song-unused', `pattern "${p}" never plays`, `/patterns/${p}`);
  // Judgement rules come with their statements: a bare id is not a checklist.
  const bands = registerOverlaps(song, spans);
  return {
    ...c.report('song', rules),
    judgementChecks: rules.filter(r => r.check === 'judgement' && r.appliesTo === 'song').map(r => ({
      rule: r.id, check: r.statement, ...(r.id === 'song-register-bands' && bands.length ? { data: bands } : {}),
    })),
  };
}

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const nn = (m: number) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

/**
 * Per section, pairs of pitched parts whose sounding ranges overlap by a fifth or more: the
 * evidence behind song-register-bands. Whether they also leave each other rhythmic gaps is judgement.
 */
export function registerOverlaps(song: Song, spans: Record<string, { low: number; high: number } | null>) {
  const c = compileSong(song);
  const out: { section: string; overlaps: string[] }[] = [];
  const seen = new Set<string>();
  for (const sec of c.sections) {
    if (seen.has(sec.name)) continue;
    seen.add(sec.name);
    const ranges = new Map<string, { lo: number; hi: number }>();
    for (const e of c.events) {
      if (e.midi === null || e.time < sec.start || e.time >= sec.end) continue;
      const sp = spans[e.track];
      const lo = e.midi + (sp?.low ?? 0), hi = e.midi + (sp?.high ?? 0);
      const r = ranges.get(e.track) ?? { lo: Infinity, hi: -Infinity };
      ranges.set(e.track, { lo: Math.min(r.lo, lo), hi: Math.max(r.hi, hi) });
    }
    const tracks = [...ranges.keys()];
    const overlaps: string[] = [];
    const fmtRange = (r: { lo: number; hi: number }) => (r.lo === r.hi ? nn(r.lo) : `${nn(r.lo)}-${nn(r.hi)}`);
    for (let i = 0; i < tracks.length; i++) for (let j = i + 1; j < tracks.length; j++) {
      const a = ranges.get(tracks[i])!, b = ranges.get(tracks[j])!;
      const shared = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
      const narrow = Math.min(a.hi - a.lo, b.hi - b.lo);
      if (shared >= Math.min(7, narrow)) overlaps.push(`${tracks[i]} ${fmtRange(a)} and ${tracks[j]} ${fmtRange(b)} share a band`);
    }
    if (overlaps.length) out.push({ section: sec.name, overlaps });
  }
  return out;
}

