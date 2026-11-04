import { expect, it } from 'vitest';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServerOwner } from '../helpers/server-owner.ts';

const bin = join(import.meta.dirname, '../../scripts/beeps.mjs');
async function start(home: string, owner: string, args = ['serve'], expectedCode = 0) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['agent_beeps_home', 'agent_beeps_server_owner'].includes(key.toLowerCase())));
  Object.assign(env, { AGENT_BEEPS_HOME: home, AGENT_BEEPS_SERVER_OWNER: owner });
  const child = spawn(process.execPath, [bin, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 20000);
  try { const [code] = await once(child, 'exit'); expect(code, stderr).toBe(expectedCode); return stdout ? JSON.parse(stdout) : undefined; }
  finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
}
async function waitClosed(port: number) {
  const until = Date.now() + 7000;
  while (Date.now() < until) {
    try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) }); }
    catch { return; }
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error('owned audition listener did not drain');
}

it('drains real detached CLI servers on success and failure without touching an unrelated server', async () => {
  const sentinel = createServer((_req, res) => res.end('unrelated sentinel'));
  await new Promise<void>(resolve => sentinel.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(sentinel.address() as AddressInfo).port}`;
  try {
    for (const fail of [false, true]) {
      const owner = await createServerOwner();
      const home = mkdtempSync(join(tmpdir(), 'beeps-owned-'));
      writeFileSync(join(home, 'keep.txt'), 'sentinel data');
      let port = 0;
      try {
        const result = await start(home, owner.value);
        const info = JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'));
        port = info.port;
        expect(info.host).toBe('127.0.0.1'); expect(port).not.toBe((sentinel.address() as AddressInfo).port);
        expect(result.pid).toBe(info.pid);
        if (fail) throw new Error('intentional test-path failure');
      } catch (error) { if (!fail || (error as Error).message !== 'intentional test-path failure') throw error; }
      finally { expect(await owner.close()).toEqual({ started: 1, drained: 1, confirmed: true }); }
      await waitClosed(port);
      expect(existsSync(join(home, 'server.json'))).toBe(false);
      expect(readFileSync(join(home, 'keep.txt'), 'utf8')).toBe('sentinel data');
      expect(await (await fetch(url)).text()).toBe('unrelated sentinel');
    }
  } finally { await new Promise<void>(resolve => sentinel.close(() => resolve())); }
});

it('drains after its owner process is abruptly cancelled, even though the starter CLI already exited', async () => {
  const owner = fork(join(import.meta.dirname, '../helpers/owner-process.ts'), { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  try {
    const [lease] = await once(owner, 'message');
    const home = mkdtempSync(join(tmpdir(), 'beeps-cancelled-'));
    await start(home, String(lease));
    const info = JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'));
    const exited = once(owner, 'exit'); owner.kill(); await exited;
    await waitClosed(info.port);
    expect(existsSync(join(home, 'server.json'))).toBe(false);
  } finally { if (owner.exitCode === null && owner.signalCode === null) owner.kill(); }
});


it('closes its lease when foreground server startup fails', async () => {
  const owner = await createServerOwner();
  const home = mkdtempSync(join(tmpdir(), 'beeps-start-failure-'));
  try { await start(home, owner.value, ['serve', '--foreground', '--port', '-1'], 1); }
  finally { expect(await owner.close()).toEqual({ started: 1, drained: 1, confirmed: true }); }
  expect(existsSync(join(home, 'server.json'))).toBe(false);
});


it('fails promptly when its owner is unavailable instead of starting a persistent server', async () => {
  const owner = await createServerOwner();
  await owner.close();
  const home = mkdtempSync(join(tmpdir(), 'beeps-missing-owner-'));
  await start(home, owner.value, ['serve', '--foreground'], 1);
  expect(existsSync(join(home, 'server.json'))).toBe(false);
});


it('isolates direct foreground startup even with an explicit wildcard host', async () => {
  const owner = await createServerOwner();
  const home = mkdtempSync(join(tmpdir(), 'beeps-foreground-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['agent_beeps_home', 'agent_beeps_server_owner'].includes(key.toLowerCase())));
  Object.assign(env, { AGENT_BEEPS_HOME: home, AGENT_BEEPS_SERVER_OWNER: owner.value });
  const child = spawn(process.execPath, [bin, 'serve', '--foreground', '--host', '0.0.0.0'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
    const info = JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'));
    expect(info.host).toBe('127.0.0.1');
    expect(info.port).toBeGreaterThan(0);
  } finally {
    try { expect(await owner.close()).toEqual({ started: 1, drained: 1, confirmed: true }); }
    finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; }
  }
});
