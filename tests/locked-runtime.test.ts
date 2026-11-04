import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describeSource } from '../scripts/managed-runtime.js';
import { selectLockedRuntime } from '../scripts/locked-runtime.js';
import { snapshot } from './helpers/build-fixture.ts';

const toolchain = { engine: 1, pipeline: 1, songPipeline: 1, exportPipeline: 1, chromium: '123@456', playwright: '1.2.3', sampleRate: 48000 };
let dir: string, home: string, config: string;
function candidate(version: string, tool = toolchain, body = '') {
  const source = join(dir, `source-${version}`);
  for (const d of ['scripts', 'src/build', 'runtime', 'craft', 'library', 'skills']) mkdirSync(join(source, d), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'agent-beeps', version, type: 'module' }));
  writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
  writeFileSync(join(source, 'tsconfig.json'), '{}');
  writeFileSync(join(source, 'scripts/beeps.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=17;');
  writeFileSync(join(source, 'src/build/lock.ts'), `${body}\nexport function currentToolchain(){return ${JSON.stringify(tool)}}`);
  const info = describeSource(source), root = join(home, 'releases', info.key);
  mkdirSync(join(home, 'releases'), { recursive: true }); renameSync(source, root);
  writeFileSync(join(root, 'managed-install.json'), JSON.stringify({ key: info.key, fingerprint: info.fingerprint }));
  return root;
}
const select = () => selectLockedRuntime(join(import.meta.dirname, '..'), config, { home });
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'beeps-locked-'))); home = join(dir, 'home'); config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ lock: 'audio.lock.json' }));
  writeFileSync(join(dir, 'audio.lock.json'), JSON.stringify({ schema: 'beeps/build-lock@1', keyScheme: 'beeps-input@1', toolchain, assets: {} }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('selects the compatible older runtime instead of the newest and preserves every fixture byte', () => {
  const older = candidate('0.10.0'); candidate('0.99.0', { ...toolchain, engine: 2 });
  const before = snapshot(dir);
  expect(select().root).toBe(older); expect(snapshot(dir)).toEqual(before);
});
it('refuses missing compatibility with the full toolchain and explicit setup guidance', () => {
  candidate('0.99.0', { ...toolchain, pipeline: 9 });
  expect(select).toThrow(/No compatible installed runtime.*Locked toolchain:.*package\/source pin.*setup.js/);
});
it('refuses ambiguity rather than inventing an exact package pin', () => {
  candidate('0.10.0'); candidate('0.11.0'); expect(select).toThrow(/Ambiguous compatible runtimes/);
});
it('uses an explicit source to disambiguate and never falls back from an incompatible pin', () => {
  const first = candidate('0.10.0'); candidate('0.11.0');
  const source = join(dir, 'trusted-pin'); cpSync(first, source, { recursive: true });
  expect(selectLockedRuntime(source, config, { home }).root).toBe(first);
  expect(selectLockedRuntime(join(import.meta.dirname, '..'), config, { home, runtimeSource: source }).root).toBe(first);
  const bad = candidate('0.12.0', { ...toolchain, pipeline: 7 }), incompatible = join(dir, 'incompatible'); cpSync(bad, incompatible, { recursive: true });
  expect(() => selectLockedRuntime(source, config, { home, runtimeSource: incompatible })).toThrow(/No compatible installed runtime/);
});
it('does not mistake a broken toolchain probe for compatibility', () => {
  candidate('0.10.0', toolchain, 'throw Error("missing dependency")');
  expect(select).toThrow(/invalid or unavailable runtime/);
});
it.each(['unknown', 'missing', 'extra', 'malformed', 'null'])('refuses %s lock identity', mode => {
  candidate('0.10.0'); const lock = JSON.parse(readFileSync(join(dir, 'audio.lock.json'), 'utf8'));
  if (mode === 'unknown') lock.toolchain.chromium = 'unknown';
  if (mode === 'missing') delete lock.toolchain.engine;
  if (mode === 'extra') lock.toolchain.future = 1;
  writeFileSync(join(dir, 'audio.lock.json'), mode === 'malformed' ? '{' : mode === 'null' ? 'null' : JSON.stringify(lock));
  expect(select).toThrow(/lock|toolchain/i);
});
it('never starts a probe with a zero timeout after fingerprinting consumes its budget', () => {
  candidate('0.10.0');
  const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(15000);
  try { expect(select).toThrow(/budget exhausted during fingerprinting/); } finally { clock.mockRestore(); }
});
it('rejects modified, wrong-ABI and linked releases before probing code', () => {
  const root = candidate('0.10.0'); writeFileSync(join(root, 'scripts/beeps.mjs'), 'throw Error("edited")');
  expect(select).toThrow(/identity mismatch/);
  const other = candidate('0.11.0'); renameSync(other, other + '-wrong-abi');
  expect(select).toThrow(/identity mismatch/);
  const linked = candidate('0.12.0'), external = join(dir, 'external'); renameSync(linked, external);
  symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  expect(select).toThrow(/escapes its home/);
});
it('detects lock changes during probing without launching the checker', () => {
  candidate('0.10.0', toolchain, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(dir, 'audio.lock.json'))}, '{}');`);
  expect(select).toThrow(/changed during qualification/);
});
it('preserves checker stdout and exit status and rejects write flags', () => {
  candidate('0.10.0');
  const launch = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '../scripts/run-managed.js'), '--locked-build-check', config, ...args], { encoding: 'utf8', env: { ...process.env, AGENT_BEEPS_HOME: home } });
  const result = launch(); expect(result.status).toBe(17);
  expect(JSON.parse(result.stdout)).toEqual(['build', '--config', config, '--check']);
  expect(launch('--adopt').status).toBe(1); expect(launch('--allow-toolchain-change').stdout).toBe('');
});
