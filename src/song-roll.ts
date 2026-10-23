// A song as text: a step grid for rhythm parts and a piano roll for pitched ones, one window of bars at a time, for an agent that cannot view
// the look image. Built from the same compiled events the renderer plays, so the roll shows what will sound, not what was written.
import { BeepsError } from './errors.ts';
import { compileSong } from '../runtime/engine/sequence.js';
import { midiName } from './music.ts';
import type { Song } from './schema/song.ts';

/** Columns are sixteenth notes; a bar is `meter * 4` of them. */
const PER_BEAT = 4;
/** Rows kept per track; a part with more distinct pitches reports how many it left out (the least used first). */
export const MAX_ROWS = 18;
/** Bars shown per call unless the caller asks for a range. */
export const DEFAULT_WINDOW_BARS = 8;

export interface RollOptions {
  /** Section name; default the first section of the form. */
  section?: string;
  /** Tracks to show; default every track that sounds in the window. */
  tracks?: string[];
  /** 1-based inclusive bars within the section; default the first {@link DEFAULT_WINDOW_BARS}. */
  bars?: [number, number];
}

export interface RollTrack { notes: number; rows: { label: string; cells: string }[]; rowsOmitted?: number }
export interface Roll {
  song: string;
  section: string;
  window: { bars: [number, number]; of: number };
  resolution: '1/16';
  /** The bar numbers over the grid, then each track's rows; a bar is separated by `|`. */
  text: string;
  tracks: Record<string, RollTrack>;
  next?: string;
}

/** `3-6` or `4` as a pair; E_USAGE for anything else. */
export function parseBars(spec: string): [number, number] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec.trim());
  if (!m) throw new BeepsError('E_USAGE', `--bars takes a bar or a range such as 1-8, got "${spec}"`, { received: spec });
  const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
  if (a < 1 || b < a) throw new BeepsError('E_USAGE', `--bars ${spec}: bars count from 1 and the end must not come before the start`, { received: spec });
  return [a, b];
}

export function songRoll(song: Song, opts: RollOptions = {}): Roll {
  const c = compileSong(song);
  const name = opts.section ?? song.form[0];
  const sec = c.sections.find(s => s.name === name);
  if (!sec) throw new BeepsError('E_USAGE', `no section "${name}" in the form of ${song.name}`, { hint: `sections: ${[...new Set(c.sections.map(s => s.name))].join(', ')}`, received: name });
  const [b0, requestedEnd] = opts.bars ?? [1, DEFAULT_WINDOW_BARS];
  if (b0 > sec.bars) throw new BeepsError('E_USAGE', `--bars starts at bar ${b0}, but section "${name}" has ${sec.bars} bar${sec.bars === 1 ? '' : 's'}`, { received: String(b0) });
  const b1 = Math.min(requestedEnd, sec.bars);
  const wanted = opts.tracks;
  for (const t of wanted ?? []) if (!Object.hasOwn(song.tracks, t)) throw new BeepsError('E_USAGE', `no track "${t}"`, { hint: `tracks: ${Object.keys(song.tracks).join(', ')}`, received: t });

  const sixteenth = c.spb / PER_BEAT, barSec = c.spb * song.meter;
  const perBar = song.meter * PER_BEAT, bars = b1 - b0 + 1, cols = bars * perBar;
  const from = sec.start + (b0 - 1) * barSec, to = from + bars * barSec;
  const col = (t: number) => Math.round((t - from) / sixteenth);

  const tracks: Record<string, RollTrack> = {};
  for (const track of wanted ?? Object.keys(song.tracks)) {
    const events = c.events.filter(e => e.track === track && e.time >= from - 1e-6 && e.time < to - 1e-6);
    if (!events.length) continue;
    const rows = new Map<string, { midi: number | null; cells: string[]; used: number }>();
    for (const e of events) {
      const key = e.midi === null ? 'hit' : midiName(e.midi);
      const row = rows.get(key) ?? { midi: e.midi, cells: Array<string>(cols).fill('.'), used: 0 };
      const at = Math.min(cols - 1, Math.max(0, col(e.time)));
      const len = e.dur === null ? 1 : Math.max(1, Math.round(e.dur / sixteenth));
      for (let i = 1; i < len && at + i < cols; i++) if (row.cells[at + i] === '.') row.cells[at + i] = '#';
      row.cells[at] = 'o';
      row.used++;
      rows.set(key, row);
    }
    // Highest pitch first, like a roll; unpitched hits (drums) sit on one row.
    const ordered = [...rows.entries()].sort((a, b) => (b[1].midi ?? -1) - (a[1].midi ?? -1));
    const kept = ordered.length > MAX_ROWS ? [...ordered].sort((a, b) => b[1].used - a[1].used).slice(0, MAX_ROWS).sort((a, b) => (b[1].midi ?? -1) - (a[1].midi ?? -1)) : ordered;
    const grid = (cells: string[]) => Array.from({ length: bars }, (_, i) => cells.slice(i * perBar, (i + 1) * perBar).join('')).join('|');
    tracks[track] = {
      notes: events.length,
      rows: kept.map(([label, r]) => ({ label, cells: grid(r.cells) })),
      ...(ordered.length > kept.length ? { rowsOmitted: ordered.length - kept.length } : {}),
    };
  }

  const width = Math.max(4, ...Object.values(tracks).flatMap(t => t.rows.map(r => r.label.length)));
  const header = `${' '.repeat(width)} ${Array.from({ length: bars }, (_, i) => String(b0 + i).padEnd(perBar)).join(' ')}`.trimEnd();
  const text = [
    `${song.name} / ${name}, bars ${b0}-${b1} of ${sec.bars} (one column is a sixteenth; o starts a note, # holds it)`,
    header,
    ...Object.entries(tracks).flatMap(([t, r]) => [
      `${t} (${r.notes} note${r.notes === 1 ? '' : 's'}${r.rowsOmitted ? `, ${r.rowsOmitted} rarely used pitch${r.rowsOmitted === 1 ? '' : 'es'} left out` : ''})`,
      ...r.rows.map(row => `${row.label.padEnd(width)} ${row.cells}`),
    ]),
  ].join('\n');
  const more = b1 < sec.bars ? `beeps song roll ${song.name} --section ${name} --bars ${b1 + 1}-${Math.min(sec.bars, b1 + bars)}` : undefined;
  return { song: song.name, section: name, window: { bars: [b0, b1], of: sec.bars }, resolution: '1/16', text, tracks, ...(more ? { next: more } : {}) };
}
