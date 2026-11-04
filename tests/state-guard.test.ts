import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireStateGuard, withStateGuard } from '../src/state-guard.ts';
import { addToKit, commitRenderedKitEntry, kitPath, readKit, updateKit } from '../src/kit.ts';
import { clearServerInfo, readServerInfo, writeServerInfo } from '../src/audition/server.ts';
import { makeFixture, snapshot } from './helpers/build-fixture.ts';
import { runBuild } from '../src/build/build.ts';
import { readLock } from '../src/build/lock.ts';
import { chromiumAvailable } from '../src/render/host.ts';
const dirs: string[] = [], children: ChildProcess[] = [];
const originalHome = process.env.AGENT_BEEPS_HOME;
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'beeps-guard-')); dirs.push(dir); return dir; };
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.AGENT_BEEPS_HOME; else process.env.AGENT_BEEPS_HOME = originalHome;
});
async function worker(mode: string, dir: string, name = '') {
  const child = fork(new URL('./helpers/state-writer.ts', import.meta.url), [mode, dir, name], { env: { ...process.env, AGENT_BEEPS_HOME: dir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  children.push(child);
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
  const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr); })]);
  expect(ready[0]).toEqual({ ready: true });
  return child;
}
async function command(child: ChildProcess, command: string) { const reply = once(child, 'message'); child.send(command); return (await reply)[0]; }

it('build check writes no guards; invalid input fails before acquisition', async () => {
  const fx = makeFixture({ config: { target: 'wav-master' } }); dirs.push(fx.dir);
  const before = snapshot(fx.dir);
  await runBuild(fx.cfg(), { check: true });
  expect(snapshot(fx.dir)).toEqual(before);
  await expect(runBuild(fx.cfg(), { only: ['does-not-exist'] })).rejects.toThrow();
  expect(() => withStateGuard(fx.cfg().lock, () => true)).not.toThrow();
});

it('an awaited failure inside a guarded build releases ownership and leaves the lock unpublished', async () => {
  const fx = makeFixture({ config: { target: 'wav-master' } }); dirs.push(fx.dir);
  let entered = false;
  await expect(runBuild(fx.cfg(), { only: ['coin'], pull: true, store: {
    spec: 'controlled-failure', has: async () => false, put: async () => 'stored',
    get: async () => {
      entered = true;
      expect(() => acquireStateGuard(fx.cfg().lock)).toThrow(/state guard/);
      await Promise.resolve();
      throw new Error('cancelled inside build');
    },
  } })).rejects.toThrow('cancelled inside build');
  expect(entered).toBe(true);
  expect(readLock(fx.cfg().lock)).toBeUndefined();
  expect(() => withStateGuard(fx.cfg().lock, () => true)).not.toThrow();
});

it.skipIf(!await chromiumAvailable())('barrier-released disjoint real builds cannot silently replace each other’s lock entries', async () => {
  const fx = makeFixture({ config: { target: 'wav-master' } }); dirs.push(fx.dir);
  const a = await worker('build', fx.dir, 'coin'), b = await worker('build', fx.dir, 'blip');
  const responses = await Promise.all([command(a, 'write'), command(b, 'write')]);
  for (const [i, response] of responses.entries()) {
    if (response.error) { expect(response.error, response.message).toBe('E_LOCK'); expect(await command([a, b][i], 'write')).toEqual({ written: true }); }
    else expect(response).toEqual({ written: true });
  }
  expect(Object.keys(readLock(fx.cfg().lock)!.assets).sort()).toEqual(['blip', 'coin']);
  expect((await runBuild(fx.cfg(), { check: true, only: ['coin', 'blip'] })).ok).toBe(true);
});

it('barrier-released independent kit writers preserve both entries or report retryable contention', async () => {
  const dir = temp();
  const a = await worker('kit', dir, 'alpha'), b = await worker('kit', dir, 'beta');
  const responses = await Promise.all([command(a, 'write'), command(b, 'write')]);
  for (const [i, response] of responses.entries()) {
    if (response.error) { expect(response.error).toBe('E_LOCK'); expect(await command([a, b][i], 'write')).toEqual({ written: true }); }
    else expect(response).toEqual({ written: true });
  }
  expect(readKit(dir).sounds.map(s => s.name).sort()).toEqual(['alpha', 'beta']);
  expect(JSON.parse(readFileSync(kitPath(dir), 'utf8')).sounds).toHaveLength(2);
});

it('a live owner excludes writers; a killed owner releases the OS lock without deleting guard files', async () => {
  const dir = temp(), path = kitPath(dir);
  updateKit(dir, current => addToKit(current, { name: 'sentinel', family: 'test', priority: 1 }));
  const owner = await worker('kit', dir, 'owner');
  // Worker target is a directory for kit writes, so use a second worker with the exact resource for holding.
  const holder = await worker('hold', path);
  expect(await command(holder, 'hold')).toEqual({ held: true });
  expect(await command(owner, 'write')).toMatchObject({ error: 'E_LOCK' });
  expect(readKit(dir).sounds.map(s => s.name)).toEqual(['sentinel']);
  const exited = once(holder, 'exit'); holder.kill(); await exited;
  expect(await command(owner, 'write')).toEqual({ written: true });
  expect(readKit(dir).sounds.map(s => s.name)).toEqual(['sentinel', 'owner']);
});

it('callback failure releases ownership and leaves the previous JSON intact', () => {
  const dir = temp();
  updateKit(dir, current => addToKit(current, { name: 'sentinel', family: 'test', priority: 1 }));
  const before = readFileSync(kitPath(dir));
  expect(() => updateKit(dir, () => { throw new Error('cancelled'); })).toThrow('cancelled');
  expect(readFileSync(kitPath(dir))).toEqual(before);
  expect(() => withStateGuard(kitPath(dir), () => true)).not.toThrow();
});

it('a stale render cannot overwrite a newly auditioned seed or trim', () => {
  const dir = temp();
  const previous = { name: 'coin', family: 'test', priority: 1, seed: 1, trimDb: -2 };
  updateKit(dir, current => addToKit(current, previous));
  const shipped = { ...previous, seed: 2, trimDb: -5 };
  updateKit(dir, current => addToKit(current, shipped));
  expect(() => commitRenderedKitEntry(dir, { ...previous, trimDb: -3 }, previous)).toThrow(/changed in the kit/);
  expect(readKit(dir).sounds).toEqual([shipped]);
  commitRenderedKitEntry(dir, { name: 'other', family: 'test', priority: 1 });
  expect(readKit(dir).sounds).toHaveLength(2);
});

it('same-process contention fails promptly instead of blocking an async owner', async () => {
  const path = join(temp(), 'state.json'), release = acquireStateGuard(path);
  try { await Promise.resolve(); expect(() => acquireStateGuard(path)).toThrow(/state guard/); }
  finally { release(); }
  expect(() => withStateGuard(path, () => true)).not.toThrow();
});

it('independent registry writers and stale startup snapshots retain registrations; old cleanup cannot remove a replacement', async () => {
  const dir = temp(); process.env.AGENT_BEEPS_HOME = dir;
  const info = { pid: 1, port: 12345, host: '127.0.0.1', token: 'test', projects: [], startedAt: 'test', url: 'http://127.0.0.1:12345' };
  writeServerInfo(info);
  const a = await worker('register', dir, join(dir, 'alpha')), b = await worker('register', dir, join(dir, 'beta'));
  const responses = await Promise.all([command(a, 'write'), command(b, 'write')]);
  for (const [i, response] of responses.entries()) if (response.error) { expect(response.error).toBe('E_LOCK'); expect(await command([a, b][i], 'write')).toEqual({ written: true }); }
  writeServerInfo({ ...info, pid: 2 });
  expect(readServerInfo()?.projects.sort()).toEqual([join(dir, 'alpha'), join(dir, 'beta')].sort());
  clearServerInfo(info);
  expect(readServerInfo()?.pid).toBe(2);
});
