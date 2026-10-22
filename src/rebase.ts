// Rebuild an instrument at another register: the override a song's `instruments` block needs so a part written far
// from the instrument's root plays as built instead of being retuned (lint `song-written-pitch`).
import { hzToMidi, noteToHz } from '../runtime/engine/notes.js';
import { instrumentRoot } from '../runtime/engine/song.js';
import { BeepsError } from './errors.ts';
import { midiName } from './music.ts';
import type { Patch } from './schema/patch.ts';

export type FilterMode = 'follow' | 'keep';

export interface Rebase {
  /** The instrument's root before and after, as note names. */
  root: string;
  rebuiltRoot: string;
  /** JSON-pointer overrides for a song's `{ base, set }` instrument. */
  set: Record<string, string | number>;
  /** Pitched layers that moved, and how many filter cutoffs were scaled with them. */
  layers: number[];
  filters: number;
}

const MIN_CUTOFF = 20, MAX_CUTOFF = 24000;
const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

/** A pitch (note name or Hz) moved by whole semitones, kept in the form it was written in. */
function shiftPitch(pitch: string | number, semitones: number): string | number {
  return typeof pitch === 'string' ? midiName(hzToMidi(noteToHz(pitch)) + semitones) : round(pitch * 2 ** (semitones / 12), 2);
}

/**
 * Moves every pitched layer's `pitch` and `pitchEnv` targets by `semitones`. With `filters: 'follow'` the cutoffs
 * of those same layers (and their sweep targets) move by the same ratio, so the tone keeps its shape at the new
 * register; noise, grain and metal layers keep their filters, because they are not tied to the note.
 */
export function rebaseInstrument(patch: Patch, semitones: number, { filters = 'follow' as FilterMode } = {}): Rebase {
  const root = instrumentRoot(patch as never);
  if (root === null) throw new BeepsError('E_USAGE', 'this instrument has no pitched layer to rebase');
  if (!Number.isInteger(semitones)) throw new BeepsError('E_USAGE', 'the shift must be a whole number of semitones');
  const set: Record<string, string | number> = {};
  const layers: number[] = [];
  let scaled = 0;
  const ratio = 2 ** (semitones / 12);
  patch.layers.forEach((layer, i) => {
    const src = layer.source as { pitch?: string | number };
    if (src.pitch === undefined) return;
    layers.push(i);
    set[`/layers/${i}/source/pitch`] = shiftPitch(src.pitch, semitones);
    layer.pitchEnv?.forEach((point, j) => { set[`/layers/${i}/pitchEnv/${j}/to`] = shiftPitch(point.to, semitones); });
    if (filters !== 'follow') return;
    const filter = layer.filter;
    if (!filter) return;
    const scale = (hz: number) => Math.min(MAX_CUTOFF, Math.max(MIN_CUTOFF, Math.round(hz * ratio)));
    set[`/layers/${i}/filter/cutoff`] = scale(filter.cutoff); scaled++;
    if (filter.env) { set[`/layers/${i}/filter/env/to`] = scale(filter.env.to); scaled++; }
  });
  return { root: midiName(root), rebuiltRoot: midiName(root + semitones), set, layers, filters: scaled };
}
