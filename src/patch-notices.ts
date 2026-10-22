// Notices about a patch as it will render under a project: the places the engine substitutes something the patch did not say.
// These run in the CLI layer. The engine and the runtime package never import src/, so the engine itself stays silent and
// the commands that wrap a render report what it did.
import { hzToMidi, noteToHz, snapToScale } from '../runtime/engine/notes.js';
import { BeepsError } from './errors.ts';
import { notice, type Notice } from './notices.ts';
import type { Patch } from './schema/patch.ts';
import type { Scale } from './schema/project.ts';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (hz: number) => { const m = Math.round(hzToMidi(hz)); return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`; };
const hz2 = (hz: number) => Math.round(hz * 100) / 100;

/** A difference under this many cents is the same note to the ear; the snap is not worth reporting. */
const SNAP_CENTS = 1;

/** One notice for each pitch (a source pitch or a pitch envelope target) that the project scale moves. */
export function scaleSnapNotices(patch: Patch, scale: Scale): Notice[] {
  if (!scale.snap) return [];
  const out: Notice[] = [];
  const check = (value: string | number, pointer: string) => {
    const hz = noteToHz(value);
    const snapped = snapToScale(hz, scale);
    if (Math.abs(1200 * Math.log2(snapped / hz)) <= SNAP_CENTS) return;
    out.push(notice('N_SCALE_SNAP', {
      message: `${pointer} is ${typeof value === 'number' ? `${value} Hz` : value} and renders as ${noteName(snapped)} (${hz2(snapped)} Hz): the project scale (${scale.root} ${scale.mode}) snaps pitches`,
      pointer, requested: value, applied: noteName(snapped),
    }));
  };
  patch.layers.forEach((layer, i) => {
    if ('pitch' in layer.source) check(layer.source.pitch, `/layers/${i}/source/pitch`);
    layer.pitchEnv?.forEach((point, j) => check(point.to, `/layers/${i}/pitchEnv/${j}/to`));
  });
  return out;
}

/** True when the patch declares several variants that cannot differ: no gain spread, and no pitch spread that any layer would follow. */
export function variantsIdentical(patch: Patch): boolean {
  const v = patch.variation;
  if (!v || v.variants < 2 || v.gainDb > 0) return false;
  const pitched = patch.layers.some(l => 'pitch' in l.source || !!l.pitchEnv?.length);
  return !(v.pitchCents > 0 && pitched);
}

/** E_USAGE for a variant index the patch does not declare: the engine would render it as written and the file would claim otherwise. */
export function requireDeclaredVariant(patch: Patch, variant: number): void {
  const declared = patch.variation?.variants ?? 1;
  if (variant >= 0 && variant < declared) return;
  throw new BeepsError('E_USAGE', `--variant ${variant} is out of range: ${patch.name} declares ${declared} variant${declared === 1 ? '' : 's'} (0 to ${declared - 1})`, {
    hint: declared === 1 ? 'declare variation.variants in the patch to render variants' : `use an index from 0 to ${declared - 1}`, received: variant,
  });
}

/** Notices for variant commands; `requested` is true when the caller asked for variants (render --variants, export --variants). */
export function variantNotices(patch: Patch, { requested = false } = {}): Notice[] {
  if (variantsIdentical(patch)) {
    return [notice('N_VARIANTS_IDENTICAL', { message: `${patch.name} declares ${patch.variation!.variants} variants, but variation.pitchCents and variation.gainDb leave them identical`, pointer: '/variation', requested: patch.variation!.variants, applied: 'identical renders' })];
  }
  if (requested && (patch.variation?.variants ?? 1) < 2) {
    return [notice('N_NO_VARIANTS', { message: `${patch.name} declares no variants, so one render was made`, pointer: '/variation', applied: 1 })];
  }
  return [];
}
