// The one place a patch's pitched layers are shifted. Both callers share the pitch move and differ only in what rides along:
// the runtime `/out/transpose` macro (params.js) also scales a metal source's `base`, and a song track (song.js) also lets
// filter cutoffs follow the note by its `keytrack`. Browser-safe: no Node APIs.
import { noteToHz } from './notes.js';

/** The highest cutoff a keytracked filter may reach, Hz. */
const KEYTRACK_CEILING_HZ = 22000;

/**
 * Shift, in place, every pitched layer of `patch` by the frequency ratio `ratio`: each source `pitch` and each `pitchEnv`
 * target (note names resolve to Hz first). With a non-zero `keytrack`, filter cutoffs and their envelope targets move by
 * `ratio ** keytrack`, capped at 22 kHz.
 * @param {any} patch  mutated: pass a copy
 * @param {number} ratio  frequency ratio, 2 ** (semitones / 12)
 * @param {{ onSource?: (source: any) => void, keytrack?: number }} [options]
 *   `onSource` sees each layer's source for caller-specific moves (a metal source's `base`); `keytrack` 0..1, default 0 (cutoffs stay)
 */
export function shiftPitchedLayers(patch, ratio, { onSource, keytrack = 0 } = {}) {
  const fRatio = ratio ** keytrack;
  for (const l of patch.layers) {
    const s = l.source;
    if ('pitch' in s) s.pitch = noteToHz(s.pitch) * ratio;
    if (onSource) onSource(s);
    if (l.pitchEnv) for (const e of l.pitchEnv) e.to = noteToHz(e.to) * ratio;
    if (l.filter && keytrack) {
      l.filter.cutoff = Math.min(KEYTRACK_CEILING_HZ, l.filter.cutoff * fRatio);
      if (l.filter.env) l.filter.env.to = Math.min(KEYTRACK_CEILING_HZ, l.filter.env.to * fRatio);
    }
  }
}
