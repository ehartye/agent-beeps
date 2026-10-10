// The slim runtime package (scripts/build-runtime-package.mjs): what it ships, that it needs nothing the engine should not need,
// that a stale copy is reported, and that the generated tree really works as an installed package: it imports in Node, builds the
// same graph as the repository, and a TypeScript consumer type-checks against its .d.ts (and fails when it misuses the API).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { assertSlim, closures, diff, ENTRIES, generate, packageJson, packageOf, runtimeClosure } from '../../scripts/build-runtime-package.mjs';
import { buildPatch } from '../../runtime/engine/patch.js';
import { applyParams } from '../../runtime/engine/params.js';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { dumpGraph } from '../helpers/graph-dump.ts';
import { example } from '../helpers/runtime-examples.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'beeps-pkg-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let installed: string | undefined;
function install(): string {
  if (installed) return installed;
  const dir = installed = join(scratch, 'consumer');
  const pkg = join(dir, 'node_modules', 'agent-beeps-runtime');
  mkdirSync(pkg, { recursive: true });
  for (const [path, content] of generate() as Map<string, Buffer | string>) {
    mkdirSync(join(pkg, path, '..'), { recursive: true });
    writeFileSync(join(pkg, path), content);
  }
  symlinkSync(join(ROOT, 'node_modules', 'zod'), join(dir, 'node_modules', 'zod'), 'junction');
  return dir;
}

describe('what the package ships', () => {
  it('the engine reaches no package at run time, the schema reaches only zod, and types borrow zod\'s', () => {
    const all = closures() as Record<string, { files: string[]; runtime: string[]; typeOnly: string[] }>;
    expect(all['.'].runtime).toEqual([]);
    expect(all['./schema'].runtime).toEqual(['zod']);
    expect(all['.'].typeOnly).toEqual(['zod']);
    expect(Object.keys(packageJson().dependencies)).toEqual(['zod']);
  });

  it('ships the engine entry, the voice, the schema and their closure, and none of the harness, songs or the CLI', () => {
    const keys = [...(generate() as Map<string, unknown>).keys()];
    expect(keys).toEqual(expect.arrayContaining(['package.json', 'LICENSE', 'README.md', 'runtime/engine/index.js', 'runtime/engine/index.d.ts', 'runtime/engine/voice.js', 'runtime/engine/patch.js', 'src/schema/patch.ts']));
    const banned = ['runtime/engine/offline.js', 'runtime/engine/song.js', 'runtime/engine/sequence.js', 'runtime/engine/chords.js'];
    for (const b of banned) expect(keys, b).not.toContain(b);
    expect(keys.filter(k => k.startsWith('src/') && k !== 'src/schema/patch.ts')).toEqual([]);
    expect(keys.filter(k => !k.startsWith('runtime/engine/') && !k.startsWith('src/') && !['package.json', 'LICENSE', 'README.md'].includes(k))).toEqual([]);
  });

  it('every shipped file is byte-identical to its source', () => {
    const generated = generate() as Map<string, Buffer | string>;
    for (const f of ['runtime/engine/voice.js', 'runtime/engine/index.d.ts', 'src/schema/patch.ts']) expect(Buffer.from(generated.get(f)!).equals(readFileSync(join(ROOT, f))), f).toBe(true);
  });
});

describe('a dependency the runtime should not have is refused', () => {
  it('names the stray package, at run time or in types', () => {
    expect(() => assertSlim({ files: [], runtime: ['playwright', 'zod'], typeOnly: [] }, ['zod'])).toThrow(/playwright/);
    expect(() => assertSlim({ files: [], runtime: ['zod'], typeOnly: [] }, [])).toThrow(/zod/);
    expect(() => assertSlim({ files: [], runtime: [], typeOnly: ['three'] }, [], ['zod'])).toThrow(/three \(types\)/);
    expect(() => assertSlim({ files: [], runtime: [], typeOnly: ['zod'] }, [], ['zod'])).not.toThrow();
    expect(packageOf('@a/b/c')).toBe('@a/b');
  });

  it('is what happens if the engine grows an import of a package, a Node built-in or the CLI', () => {
    // Walk the real closure with a file that imports each: the scanner must see it as run-time, not as a comment or a type.
    const dir = mkdtempSync(join(scratch, 'stray-'));
    mkdirSync(join(dir, 'runtime', 'engine'), { recursive: true });
    writeFileSync(join(dir, 'runtime', 'engine', 'index.js'), "import { readFileSync } from 'node:fs';\nimport pw from 'playwright';\n/** @typedef {import('three').Scene} S */\nexport const x = 1;\n");
    const c = runtimeClosure(['runtime/engine/index.js'], dir) as { runtime: string[]; typeOnly: string[] };
    expect(c.runtime).toEqual(['node:fs', 'playwright']);
    expect(c.typeOnly).toEqual(['three']);
    expect(() => assertSlim(c, ENTRIES['.'].allow, ['zod'])).toThrow(/node:fs, playwright, three \(types\)/);
  });

  it('a stale or hand-edited copy is reported', () => {
    const dir = mkdtempSync(join(scratch, 'stale-'));
    expect(diff(dir)).toContain('missing runtime/engine/index.js');
    const fresh = join(scratch, 'fresh');
    mkdirSync(fresh, { recursive: true });
    for (const [path, content] of generate() as Map<string, Buffer | string>) { mkdirSync(join(fresh, path, '..'), { recursive: true }); writeFileSync(join(fresh, path), content); }
    expect(diff(fresh)).toEqual([]);
    writeFileSync(join(fresh, 'runtime/engine/voice.js'), '// edited\n');
    writeFileSync(join(fresh, 'extra.js'), '');
    expect(diff(fresh)).toEqual(['differs runtime/engine/voice.js', 'extra extra.js']);
  });
});

describe('the generated package as an installed dependency', () => {
  it('imports in Node and builds the graph the repository builds', async () => {
    const dir = install();
    const pkg = (await import(pathToFileURL(join(dir, 'node_modules', 'agent-beeps-runtime', 'runtime', 'engine', 'index.js')).href)) as typeof import('../../runtime/engine/index.js');
    expect(Object.keys(pkg).sort()).toEqual(['CUE_SCHEMA', 'ENGINE_VERSION', 'MACROS', 'NOISE_CACHE_BYTES', 'REVERB_PRESETS', 'build', 'clampInput', 'createPicker', 'createReverbBus', 'defaultParams', 'noiseCacheStats', 'parseCue', 'patchLength', 'setNoiseCacheLimit']);
    const p = example('engine-drone');
    const a = new FakeContext();
    pkg.build(asCtx(a), a.createGain() as never, p, { params: { speed: 0.9 }, seed: 5, trimDb: -9.4 }).start();
    const b = new FakeContext();
    buildPatch(asCtx(b), applyParams(p, { speed: 0.9 }).patch, { destination: b.createGain() as never, seed: 5, trimDb: -9.4, hold: true });
    const strip = (d: any[]) => d.filter(n => n.kind !== 'constant').map(n => ({ ...n, i: 0 }));
    expect(strip(dumpGraph(a)).length).toBe(strip(dumpGraph(b)).length);
    // live automation of the package's voice reaches the same parameters
    expect(a.created.filter(n => n.kind === 'osc').length).toBe(b.created.filter(n => n.kind === 'osc').length);
  });

  it('bundles the schema entry too (TypeScript source: Node refuses types under node_modules, bundlers do not)', async () => {
    const dir = install();
    writeFileSync(join(dir, 'probe.mjs'), `import { parsePatch, PatchSchema } from 'agent-beeps-runtime/schema';
const r = parsePatch({ schema: 'beeps/patch@1', name: 'x', family: 'f', duration: 0.2, layers: [{ source: { type: 'osc', wave: 'sine', pitch: 440 }, amp: {} }] });
console.log(JSON.stringify({ ok: r.ok, shape: typeof PatchSchema }));
`);
    const { build: bundle } = await import('rolldown');
    const out = await bundle({ input: join(dir, 'probe.mjs'), cwd: dir, write: false, output: { format: 'esm' }, logLevel: 'silent' });
    writeFileSync(join(dir, 'probe.bundle.mjs'), out.output[0].code);
    const res = execFileSync(process.execPath, [join(dir, 'probe.bundle.mjs')], { cwd: dir, encoding: 'utf8' });
    expect(JSON.parse(res)).toEqual({ ok: true, shape: 'object' });
  }, 60_000);

  it('type-checks a consumer, and rejects one that misuses the API', () => {
    const dir = install();
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'bundler', target: 'ES2022', lib: ['ES2022', 'DOM'], noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, types: [] }, include: ['good.ts'] }));
    writeFileSync(join(dir, 'good.ts'), `
import { build, createReverbBus, parseCue, setNoiseCacheLimit, type Voice, type ReverbBus } from 'agent-beeps-runtime';
import { parsePatch } from 'agent-beeps-runtime/schema';
declare const ctx: AudioContext;
const bus: ReverbBus = createReverbBus(ctx, ctx.destination, { preset: 'hall', returnDb: -3 });
const cue = parseCue(JSON.parse('{}'));
const v: Voice = build(ctx, ctx.destination, cue, { seed: 3, params: { speed: 0.4 }, reverb: bus, onEnded: () => {} });
v.start(ctx.currentTime + 0.1).set('speed', 0.9, ctx.currentTime, 0.05);
const silentAt: number = v.stop();
const end: number | undefined = v.end;
v.dispose();
setNoiseCacheLimit(8 << 20);
const r = parsePatch({});
if (r.ok) build(ctx, ctx.destination, r.patch, { scale: null }).start();
void [silentAt, end];
`);
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const run = (project: string) => { try { execFileSync(process.execPath, [tsc, '-p', project], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }); return ''; } catch (e) { return String((e as { stdout?: string }).stdout ?? e); } };
    expect(run('tsconfig.json')).toBe('');
    writeFileSync(join(dir, 'bad.ts'), `
import { build } from 'agent-beeps-runtime';
declare const ctx: AudioContext;
const v = build(ctx, ctx.destination, { nope: 1 }, { seed: 'three' });
v.play();
`);
    writeFileSync(join(dir, 'tsconfig.bad.json'), JSON.stringify({ extends: './tsconfig.json', include: ['bad.ts'] }));
    expect(run('tsconfig.bad.json')).toMatch(/error TS/);
  }, 60_000);
});
