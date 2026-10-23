// Input values given on a command line (`--set size=1,distance=0.4`, `--input speed --to 4`), checked against what the patch
// declares. The engine clamps an out-of-range value to be safe at play time; a command that echoes what was asked must not
// pretend that value applied, so the commands resolve first and report what was used.
import { BeepsError } from '../errors.ts';
import { notice, type Notice } from '../notices.ts';
import type { Patch } from '../schema/patch.ts';

/** `k=v,k=v` pairs as numbers; a pair with no `=` or a value that is not a finite number is E_USAGE naming it. */
export function parseInputPairs(pairs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kv of pairs) {
    const [k, v] = kv.split('=');
    const n = v === undefined || v.trim() === '' ? NaN : Number(v);
    if (!k || !Number.isFinite(n)) throw new BeepsError('E_USAGE', `"${kv}" is not an input value`, { hint: 'write name=number, for example size=1,distance=0.4', received: kv });
    out[k] = n;
  }
  return out;
}

/** The values the engine will use for `asked`: unknown inputs are E_USAGE, and a value outside its range comes back clamped with an `N_INPUT_CLAMPED` notice. */
export function resolveInputs(patch: Patch, asked: Record<string, number>): { params: Record<string, number>; notices: Notice[] } {
  const declared = patch.xRuntime?.inputs ?? {};
  const params: Record<string, number> = {};
  const notices: Notice[] = [];
  for (const [name, value] of Object.entries(asked)) {
    const d = declared[name];
    if (!d) throw new BeepsError('E_USAGE', `${patch.name} declares no input "${name}"`, { hint: Object.keys(declared).length ? `declared inputs: ${Object.keys(declared).join(', ')}` : 'the patch has no xRuntime inputs', received: name });
    params[name] = Math.min(d.max, Math.max(d.min, value));
    if (params[name] !== value) {
      notices.push(notice('N_INPUT_CLAMPED', {
        message: `${name}=${value} is outside ${d.min} to ${d.max}, so ${params[name]} was used`,
        pointer: `/xRuntime/inputs/${name}`, requested: value, applied: params[name],
      }));
    }
  }
  return { params, notices };
}
