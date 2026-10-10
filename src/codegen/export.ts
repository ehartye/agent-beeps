// EXPERIMENTAL (runtime-codegen spike). Write a vendorable `beeps-runtime/` folder: the engine files a runtime path needs,
// one generated module per cue (option B), and optionally the interpreter (option A), plus a manifest a build can diff.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RUNTIME_DIR } from '../render/host.ts';
import { ENGINE_VERSION } from '../../runtime/engine/version.js';
import { canonicalJson, sha256 } from '../hash.ts';
import type { Patch } from '../schema/patch.ts';
import { emitModule } from './emit.ts';

/** What generated cue modules import, transitively. `layer.js` and `sources.js` also carry the interpreter's builders; a bundler drops them. */
export const GEN_ENGINE_FILES = ['gen.js', 'params.js', 'sum.js', 'rng.js', 'notes.js', 'sources.js', 'fx.js', 'layer.js', 'voice.d.ts', 'version.js'];
/** The interpreter (option A): `createVoice` on top of the engine the renderer runs. */
export const INTERP_ENGINE_FILES = ['live.js', 'patch.js', 'variation.js'];

export interface CueInput { patch: Patch; trimDb: number; seed: number }

export interface RuntimeManifest {
  schema: 'beeps/runtime@0-experimental';
  engine: string;
  mode: ('codegen' | 'interpreter')[];
  cues: Record<string, { module: string; patchHash: string; trimDb: number; seed: number; hold: boolean; inputs: string[]; live: string[]; bytes: number }>;
}

export const patchHash = (p: Patch): string => sha256(canonicalJson(p));

export function exportRuntime(dir: string, cues: CueInput[], { interpreter = false, codegen = true }: { interpreter?: boolean; codegen?: boolean } = {}) {
  const root = join(resolve(dir), 'beeps-runtime');
  rmSync(root, { recursive: true, force: true });
  const files = [...GEN_ENGINE_FILES, ...(interpreter ? INTERP_ENGINE_FILES : [])];
  const header = `// Vendored by agent-beeps (EXPERIMENTAL runtime spike), engine ${ENGINE_VERSION}. Regenerate with "beeps runtime emit"; do not edit.\n`;
  for (const f of files) {
    const dest = join(root, 'engine', f);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, header + readFileSync(join(RUNTIME_DIR, 'engine', f), 'utf8'));
  }
  const manifest: RuntimeManifest = { schema: 'beeps/runtime@0-experimental', engine: ENGINE_VERSION, mode: [...(codegen ? ['codegen' as const] : []), ...(interpreter ? ['interpreter' as const] : [])], cues: {} };
  if (interpreter) {
    // The interpreter plays the patch JSON itself: ship it as data, beside the modules.
    mkdirSync(join(root, 'patches'), { recursive: true });
  }
  for (const { patch, trimDb, seed } of cues) {
    const hash = patchHash(patch);
    let bytes = 0;
    if (codegen) {
      const e = emitModule(patch, { trimDb, seed, patchHash: hash });
      mkdirSync(join(root, 'cues'), { recursive: true });
      writeFileSync(join(root, 'cues', `${patch.name}.js`), e.js);
      writeFileSync(join(root, 'cues', `${patch.name}.d.ts`), e.dts);
      bytes = Buffer.byteLength(e.js);
      manifest.cues[patch.name] = { module: `cues/${patch.name}.js`, patchHash: hash, trimDb, seed, hold: patch.xRuntime?.hold === true, inputs: Object.keys(patch.xRuntime?.inputs ?? {}), live: e.liveInputs, bytes };
    }
    if (interpreter) {
      writeFileSync(join(root, 'patches', `${patch.name}.json`), JSON.stringify(patch));
      manifest.cues[patch.name] ??= { module: `patches/${patch.name}.json`, patchHash: hash, trimDb, seed, hold: patch.xRuntime?.hold === true, inputs: Object.keys(patch.xRuntime?.inputs ?? {}), live: [], bytes: 0 };
    }
  }
  writeFileSync(join(root, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { root, manifest };
}
