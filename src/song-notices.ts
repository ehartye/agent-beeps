// Notices about a song as it will render: the places the sequencer or the effects cut something the song wrote. These run in the CLI
// layer (the engine stays silent) from the song document alone, so `song check` can say them without rendering.
import { compileSong, patternEvents } from '../runtime/engine/sequence.js';
import { trackShift } from '../runtime/engine/song.js';
import { declaredFrequencies } from './lint.ts';
import type { Patch } from './schema/patch.ts';
import { mulberry32 } from '../runtime/engine/rng.js';
import { notice, type Notice } from './notices.ts';
import type { Song } from './schema/song.ts';
import { delayTailNotice } from './patch-notices.ts';

const EPS = 1e-6;

/**
 * One notice for each place a pattern runs past the end of the section that plays it. The sequencer starts a pattern at the section's
 * first beat and again after each pass, and drops every note that would start at or after the section's last beat, so a long pattern
 * (or a short section) loses the end of the phrase without an error. A pattern whose cut-off part has no notes (rests) loses nothing.
 */
export function patternTruncationNotices(song: Song): Notice[] {
  const out: Notice[] = [];
  const meter = song.meter;
  for (const name of new Set(song.form)) {
    const sec = song.sections[name];
    const len = sec.bars * meter;
    for (const [track, ref] of Object.entries(sec.play)) {
      if (ref === null) continue;
      const list = Array.isArray(ref) ? ref : [ref];
      const reported = new Set<string>();
      for (let pos = 0, i = 0; pos < len - EPS; i++) {
        const pname = list[i % list.length];
        const p = song.patterns[pname];
        if (pos + p.bars * meter > len + EPS && !reported.has(pname)) {
          const lost = patternEvents(song, p, mulberry32(1)).filter(e => pos + e.beat >= len - EPS).length;
          if (lost) {
            reported.add(pname);
            out.push(notice('N_PATTERN_TRUNCATED', {
              message: `section "${name}" is ${sec.bars} bars; track "${track}" plays pattern "${pname}" (${p.bars} bars) from bar ${pos / meter + 1}, so ${lost} note${lost === 1 ? '' : 's'} past the section end never sound`,
              pointer: `/sections/${name}/play/${track}`, requested: `${p.bars} bars`, applied: `${Math.max(0, len - pos) / meter} bars`,
            }));
          }
        }
        pos += p.bars * meter;
      }
    }
  }
  return out;
}

/** Fields that parse and do nothing where they are: `hitBeats` and `note` belong to `steps` patterns, and a note tuple has four values at most (start, note, length, velocity). `stepsPerBeat` cannot be told from its default once parsed, so it is not checked. */
export function unusedFieldNotices(song: Song): Notice[] {
  const out: Notice[] = [];
  for (const [name, p] of Object.entries(song.patterns)) {
    if (!p.steps) {
      for (const field of ['hitBeats', 'note'] as const) {
        if (p[field] !== undefined) out.push(notice('N_UNUSED_FIELD', { message: `pattern "${name}" sets ${field}, which only a steps pattern reads`, pointer: `/patterns/${name}/${field}`, requested: field }));
      }
    }
    (p.notes ?? []).forEach((n, i) => {
      if (Array.isArray(n) && n.length > 4) out.push(notice('N_UNUSED_FIELD', { message: `pattern "${name}" note ${i} has ${n.length} values; only the first four (start, note, length, velocity) are read`, pointer: `/patterns/${name}/notes/${i}`, requested: n.length, applied: 4 }));
    });
  }
  return out;
}

/** The song's master delay, when its feedback tail is longer than the 8 seconds the render keeps. */
export function songDelayNotices(song: Song): Notice[] {
  const d = song.master.delay;
  return d ? delayTailNotice('/master/delay', (d.beats * 60) / song.bpm, d.feedback) : [];
}

/** The engine's cap on a keytracked cutoff, Hz (runtime/engine/transpose.js). */
const KEYTRACK_CEILING_HZ = 22000;

/**
 * What the highest written note of each track does to its instrument: a declared partial or layer that lands at or above 0.45 of the sample rate
 * (aliased or dropped), and a keytracked cutoff the engine would cap. Computed from the document and the instruments, as the engine moves the
 * instrument by `trackShift` semitones for each note; the engine itself stays silent about both.
 */
export function registerNotices(song: Song, instruments: Record<string, Patch>, sampleRate: number): Notice[] {
  const out: Notice[] = [];
  const top = new Map<string, number>();
  for (const e of compileSong(song).events) if (e.midi !== null) top.set(e.track, Math.max(top.get(e.track) ?? -Infinity, e.midi));
  const limit = 0.45 * sampleRate;
  for (const [track, t] of Object.entries(song.tracks)) {
    const p = instruments[track], midi = top.get(track);
    const shiftOf = p && midi !== undefined ? trackShift(t, p) : null;
    if (!p || midi === undefined || !shiftOf) continue;
    const semitones = shiftOf(midi), ratio = 2 ** (semitones / 12);
    const worst = declaredFrequencies(p).reduce<{ hz: number; pointer: string } | undefined>((w, f) => (!w || f.hz > w.hz ? f : w), undefined);
    if (worst && worst.hz * ratio >= limit) {
      out.push(notice('N_PARTIAL_ABOVE_NYQUIST', {
        message: `track "${track}": at its highest note (${Math.round(top.get(track)!)} as MIDI, shifted ${Math.round(semitones * 10) / 10} semitones) ${worst.pointer} would sound at ${Math.round(worst.hz * ratio)} Hz, at or above ${Math.round(limit)} Hz (0.45 x sample rate)`,
        pointer: `/tracks/${track}`, requested: Math.round(worst.hz * ratio), applied: Math.round(limit),
      }));
    }
    if (t.keytrack > 0) {
      for (const [i, layer] of p.layers.entries()) {
        const f = layer.filter;
        if (!f) continue;
        const reach = Math.max(f.cutoff, f.env?.to ?? 0) * ratio ** t.keytrack;
        if (reach > KEYTRACK_CEILING_HZ) {
          out.push(notice('N_CUTOFF_CAPPED', {
            message: `track "${track}": the layer ${i} cutoff would follow the highest note up to ${Math.round(reach)} Hz; the engine caps a keytracked cutoff at ${KEYTRACK_CEILING_HZ} Hz`,
            pointer: `/tracks/${track}/keytrack`, requested: Math.round(reach), applied: KEYTRACK_CEILING_HZ,
          }));
          break;
        }
      }
    }
  }
  return out;
}

/** Everything about a song's document that cuts something the song wrote; with the instruments, what its highest notes do to them. */
export const songNotices = (song: Song, instruments?: Record<string, Patch>, sampleRate = 48000): Notice[] => [
  ...patternTruncationNotices(song), ...songDelayNotices(song), ...unusedFieldNotices(song),
  ...(instruments ? registerNotices(song, instruments, sampleRate) : []),
];
