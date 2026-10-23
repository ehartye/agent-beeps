// Notices about a song as it will render: the places the sequencer or the effects cut something the song wrote. These run in the CLI
// layer (the engine stays silent) from the song document alone, so `song check` can say them without rendering.
import { patternEvents } from '../runtime/engine/sequence.js';
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

/** Everything about a song's document that cuts something the song wrote. */
export const songNotices = (song: Song): Notice[] => [...patternTruncationNotices(song), ...songDelayNotices(song), ...unusedFieldNotices(song)];
