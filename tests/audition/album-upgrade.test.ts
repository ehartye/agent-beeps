import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../../src/project.ts';
import { writeAlbum } from '../../src/album.ts';
import { ensureServer } from '../../src/commands/audition.ts';
import { readServerInfo, SERVER_API, serverInfoFile } from '../../src/audition/server.ts';

it('upgrades the server without changing bookmarked links or dropping registered projects', async () => {
  process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-upgrade-'));
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-upgrade-project-')));
  const album = writeAlbum(p, { title: 'Existing album', tracks: [{ name: 'song', title: 'Song', loop: false, durationSec: 10, wav: 'old/delivered.wav', look: 'old/look.png' }] });
  const fixture = join(process.env.AGENT_BEEPS_HOME, 'old-server.mjs');
  writeFileSync(fixture, `
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
const file = process.argv[2], project = process.argv[3];
const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, authed: new URL(req.url, 'http://x').searchParams.get('t') === 'old-token', pid: process.pid, api: 2 })); });
server.listen(0, '127.0.0.1', () => { const port = server.address().port; writeFileSync(file, JSON.stringify({ pid: process.pid, port, host: '127.0.0.1', token: 'old-token', projects: [project], startedAt: new Date().toISOString(), url: 'http://127.0.0.1:' + port, api: 2 })); console.log('ready'); });
process.on('SIGTERM', () => { try { if (JSON.parse(readFileSync(file)).pid === process.pid) rmSync(file); } catch {} process.exit(0); });
`);
  const old = spawn(process.execPath, [fixture, serverInfoFile(), p.paths.root], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let replacement: number | undefined;
  try {
    await once(old.stdout!, 'data');
    const prior = readServerInfo()!;
    const current = await ensureServer();
    replacement = current.pid;
    expect(current.api).toBe(SERVER_API);
    expect(current.token).toBe(prior.token);
    expect(current.url).toBe(prior.url);
    expect(current.projects).toContain(p.paths.root);
    const bookmarked = await fetch(`${prior.url}/api/album/${album.id}?t=${prior.token}`);
    expect(bookmarked.status).toBe(200);
    expect((await bookmarked.json()).title).toBe('Existing album');
  } finally {
    old.kill();
    if (replacement) { try { process.kill(replacement); } catch { /* already exited */ } }
  }
}, 25000);
