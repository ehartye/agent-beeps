// Output paths that would overwrite something other than the caller meant: an input, or a file that differs from the output only in case
// (the same file on Windows and macOS). Commands that write a file or a folder from a path the caller typed check it here first.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { BeepsError } from './errors.ts';

/** True where `Coin.wav` and `coin.wav` name one file. */
export const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/** A comparable form of a path: absolute, symlinks resolved where the path exists, lower-cased on a case-insensitive filesystem. */
function key(path: string): string {
  let p = resolve(path);
  try { p = realpathSync.native(p); } catch { /* not there yet: compare as written */ }
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

export const sameFile = (a: string, b: string): boolean => key(a) === key(b);

/** True when `child` is a path below `parent` (equal paths are not inside). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(key(parent), key(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The entry of `dest`'s folder that has the same name ignoring case but is not spelled the same, if there is one. */
export function caseCollision(dest: string): string | undefined {
  const dir = dirname(resolve(dest));
  if (!existsSync(dir)) return undefined;
  const name = basename(dest);
  return readdirSync(dir).find(e => e !== name && e.toLowerCase() === name.toLowerCase());
}

export interface OutputRule {
  /** Required extension, with the dot (`.wav`); compared ignoring case. */
  ext?: string;
  /** Files or folders this command reads: the output may not be one of them, inside one, or contain one. */
  inputs?: string[];
}

/** E_USAGE for the wrong extension; E_CONFLICT for an output that is an input or overlaps one, or collides in case with an existing file. */
export function requireSafeOutput(dest: string, rule: OutputRule = {}, what = 'the output'): void {
  if (rule.ext && extname(dest).toLowerCase() !== rule.ext) {
    throw new BeepsError('E_USAGE', `${what} must end in ${rule.ext}, not "${basename(dest)}"`, { hint: `name the file <something>${rule.ext}`, received: basename(dest) });
  }
  for (const input of rule.inputs ?? []) {
    if (sameFile(dest, input) || isInside(dest, input) || isInside(input, dest)) {
      throw new BeepsError('E_CONFLICT', `${what} (${dest}) is, or overlaps, an input of this command (${input}), so it would overwrite it`, { hint: 'choose an output path outside the inputs', received: dest });
    }
  }
  const clash = caseCollision(dest);
  if (clash) {
    throw new BeepsError('E_CONFLICT', `${what} "${basename(dest)}" differs only in case from the existing "${clash}" in the same folder, which is one file on Windows and macOS`, {
      hint: `choose a name that differs by more than case, or remove "${clash}" first`, received: basename(dest),
    });
  }
}

/** Two folders that must not be the same, nor one inside the other (re-encoding a bundle into itself would read what it writes). */
export function requireDistinctDirs(source: string, out: string, what = 'the output directory'): void {
  if (sameFile(source, out) || isInside(out, source) || isInside(source, out)) {
    throw new BeepsError('E_USAGE', `${what} must be a different folder from the source, and not inside it or around it`, { hint: 'choose a fresh folder beside the source', received: out });
  }
}
