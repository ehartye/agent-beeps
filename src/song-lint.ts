// Craft lint for songs: craft/music-rules.json applied to a song's declaration and measured features.
import { join } from 'node:path';
import { Collector, loadRules, RULES_PATH, type LintReport } from './lint.ts';
import type { SongFeatures } from './measure/song.ts';
import type { Song } from './schema/song.ts';
import type { Project } from './schema/project.ts';
import { compileSong } from '../runtime/engine/sequence.js';

export const MUSIC_RULES_PATH = join(RULES_PATH, '..', 'music-rules.json');

const fmt = (x: number, d = 1) => String(Math.round(x * 10 ** d) / 10 ** d);

export function lintSong(song: Song, f: SongFeatures, project: Project): LintReport {
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
    if (f.seamDb !== undefined && f.seamDb > c.num('song-loop-seam')) c.add('song-loop-seam', `level steps ${fmt(f.seamDb)} dB at the loop point: end the form at a similar density to how it starts`, '/form');
    const len = range('song-loop-length');
    const long = song.tags.some(t => c.param<string[]>('song-loop-length', 'longTags').includes(t));
    const min = long ? len.long : len.short;
    if (f.durationSec < min) c.add('song-loop-length', `a ${fmt(f.durationSec, 0)} s loop${long ? ` tagged ${song.tags.join(', ')}` : ''} repeats too soon (at least ${min} s)`, '/form');
  }
  const low = range('song-low-end');
  if (f.lowShare > low.max) c.add('song-low-end', `${fmt(100 * f.lowShare, 0)}% of energy is below 120 Hz: bass or kick masks the mix`);
  else if (f.lowShare < low.min) c.add('song-low-end', `only ${fmt(100 * f.lowShare, 1)}% of energy below 120 Hz: thin`);

  const reg = range('song-register');
  const outside = new Map<string, { lo: number; hi: number }>();
  for (const e of compileSong(song).events) {
    if (e.midi === null || (e.midi >= reg.lowestMidi && e.midi <= reg.highestMidi)) continue;
    const o = outside.get(e.pattern) ?? { lo: Infinity, hi: -Infinity };
    outside.set(e.pattern, { lo: Math.min(o.lo, e.midi), hi: Math.max(o.hi, e.midi) });
  }
  for (const [pattern, o] of outside) {
    const hz = (m: number) => fmt(440 * 2 ** ((m - 69) / 12), 0);
    c.add('song-register', o.lo < reg.lowestMidi ? `pattern "${pattern}" reaches ${hz(o.lo)} Hz (below E1): raise its octave` : `pattern "${pattern}" reaches ${hz(o.hi)} Hz (above C8): lower its octave`, `/patterns/${pattern}`);
  }

  const played = new Set<string>(), usedTracks = new Set<string>();
  for (const name of new Set(song.form)) for (const [track, ref] of Object.entries(song.sections[name].play)) {
    if (ref === null) continue;
    usedTracks.add(track);
    for (const r of Array.isArray(ref) ? ref : [ref]) played.add(r);
  }
  for (const t of Object.keys(song.tracks)) if (!usedTracks.has(t)) c.add('song-unused', `track "${t}" never plays`, `/tracks/${t}`);
  for (const p of Object.keys(song.patterns)) if (!played.has(p)) c.add('song-unused', `pattern "${p}" never plays`, `/patterns/${p}`);
  return c.report('song', rules);
}
