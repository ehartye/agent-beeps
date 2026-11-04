import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, type OpenProject } from '../../src/project.ts';
import { writeSet } from '../../src/sets.ts';
import { openSession, readEvents } from '../../src/audition/session.ts';
import { AuditionServer, previewLinks, type ServerInfo } from '../../src/audition/server.ts';
import { PreviewGrants } from '../../src/audition/preview.ts';
import { createPreview } from '../../src/commands/preview.ts';
import { writeAlbum, readAlbum, foldAlbum } from '../../src/album.ts';
import { createDelivery, sourceFromFile, resolvePresets } from '../../src/audition/delivery.ts';
import { writeWav } from '../../src/audio/wav.ts';
import { coin } from '../helpers/patches.ts';

const feat = (c: number) => ({ durationSec: 0.3, samplePeakDb: -6, truePeakDb: -6, dcOffset: 0, clippedSamples: 0, momentaryMaxLufs: -18, shortTermMaxLufs: -20, integratedLufs: -20, integratedReliable: false, attackSec: 0.004, energyLengthSec: 0.1 * c, tailSec: 0.2, crestDb: 8, centroidHz: 700 * c, centroidPeakHz: 700 * c, flatness: 0.05, bands: [], sharpness: c / 2, roughness: 0.02, fluctuation: 0.01, pitchHz: 1000, pitchStrength: 0.9, pitchDirection: 5, voicedFraction: 0.9, delivered: { samplePeakDb: -8, truePeakDb: -8, momentaryMaxLufs: -19, clippedSamples: 0 } });

let server: AuditionServer, info: ServerInfo, p: OpenProject, other: OpenProject, browser: Browser;
let session: string, album: string, delivery: string;
const base = () => `http://127.0.0.1:${info.port}`;
const secret = (share: any) => new URLSearchParams(new URL(share.url).hash.slice(1)).get('preview')!;
const get = (path: string, share: any, init: RequestInit = {}) => fetch(base() + path, { ...init, headers: { 'x-beeps-preview': secret(share), ...init.headers } });
const post = (path: string, share: any, body: unknown) => get(path, share, { method: 'POST', body: JSON.stringify(body) });

beforeAll(async () => {
  process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-preview-home-'));
  p = initProject(mkdtempSync(join(tmpdir(), 'beeps-preview-')));
  other = initProject(mkdtempSync(join(tmpdir(), 'beeps-preview-other-')));
  writeSet(p, { id: 'preview-set', family: 'coin', archetype: 'coin', prompt: 'Preview coins', parent: null, createdAt: new Date().toISOString(), sheet: null,
    candidates: [1, 2].map(i => ({ index: i, name: `c-${i}`, key: `k${i}`, seed: 1, trimDb: 0, features: feat(i) as any, wav: '', look: '' })) },
    [1, 2].map(i => ({ ...coin(), name: `c-${i}` })));
  session = openSession(p, 'preview-set', { requirePrediction: false, context: { kit: false, bed: false } }).id;
  const dir = join(p.paths.renders, 'preview'); mkdirSync(dir);
  const wav = join(dir, 'delivered.wav');
  writeFileSync(wav, writeWav([new Float32Array(48000)], 48000));
  writeFileSync(join(dir, 'look.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const tracks = [{ name: 'demo', title: 'Demo song', loop: false, durationSec: 1, wav, look: join(dir, 'look.png'), features: {}, sections: [] }];
  album = writeAlbum(p, { id: 'same-id', title: 'Shared album', tracks }).id;
  writeAlbum(other, { id: 'same-id', title: 'Private other project', tracks });
  delivery = createDelivery(p, [sourceFromFile(wav)], resolvePresets(['wav', 'mp3-96'], { anchor: false }), { encoder: (_f, source, out) => copyFileSync(source, out) }).id;
  server = new AuditionServer({ host: '127.0.0.1', port: 0, token: 'owner-secret', projects: [other.paths.root, p.paths.root] });
  info = await server.listen();
  browser = await chromium.launch();
});
afterAll(async () => { vi.restoreAllMocks(); await browser?.close(); await server?.close(); });

it('bounds lifetime and count; expires, revokes and forgets capabilities', () => {
  let now = 1000; const grants = new PreviewGrants(() => now);
  const input = { kind: 'album' as const, target: 'a', root: 'root', feedback: false };
  for (const ttl of [0, 59, 86401, NaN, 60.5]) expect(() => grants.issue(input, ttl)).toThrow();
  const a = grants.issue(input, 60); now += 60000;
  expect(grants.get(a.token)).toBeUndefined();
  const b = grants.issue(input); expect(grants.revoke(b.grant.id)).toBe(true); expect(grants.get(b.token)).toBeUndefined();
  const c = grants.issue(input); grants.clear(); expect(grants.get(c.token)).toBeUndefined();
  for (let i = 0; i < 256; i++) grants.issue(input);
  expect(() => grants.issue(input)).toThrow(/limit/);
});

it('pins the exact project despite duplicate ids and denies enumeration, management and cross-session access', async () => {
  const share = await createPreview(info, p.paths.root, 'album', album);
  expect(share.tailscaleUrl).toBeNull(); expect(share.url).toBe(share.localUrl);
  expect(JSON.stringify(share)).not.toContain(info.token);
  const payload = await (await get(`/api/album/${album}`, share)).json();
  expect(payload.title).toBe('Shared album'); expect(JSON.stringify(payload)).not.toContain(p.paths.root);
  for (const path of ['/api/sessions', '/api/albums', `/api/session/${session}`, '/api/album/other', `/api/album/${album}suffix`]) expect((await get(path, share)).status).toBe(403);
  expect((await post('/api/previews', share, {})).status).toBe(403);
  expect((await post(`/api/album/${album}/event`, share, { type: 'play', index: 1 })).status).toBe(403);
  expect((await get(`/api/album/${album}/wav/1`, share, { headers: { range: 'bytes=0-15' } })).status).toBe(206);
  expect((await get(`/api/album/${album}`, share, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  const revoke = await fetch(`${base()}/api/previews/${share.id}`, { method: 'DELETE', headers: { 'x-beeps-token': info.token } });
  expect(revoke.status).toBe(200);
  expect((await get(`/api/album/${album}/wav/1`, share)).status).toBe(403);
});

it('allows only deliberate feedback and keeps owner behavior available', async () => {
  const share = await createPreview(info, p.paths.root, 'session', session, true);
  const path = `/api/session/${session}/event`;
  expect((await post(path, share, { type: 'play', index: 1, mode: '1' })).status).toBe(200);
  expect((await post(path, share, { type: 'lineup', loved: [1, 2], duds: [] })).status).toBe(200);
  for (const type of ['ship', 'refine', 'abandon', 'round', 'refineFailed']) expect((await post(path, share, { type, champion: 1 })).status).toBe(403);
  expect((await get(`/api/session/${session}/reveal`, share)).status).toBe(403);
  expect((await fetch(base() + '/api/sessions', { headers: { 'x-beeps-token': info.token } })).status).toBe(200);
  const d = await createPreview(info, p.paths.root, 'delivery', delivery, true);
  expect((await post(`/api/delivery/${delivery}/event`, d, { type: 'note', text: 'Good' })).status).toBe(200);
  expect((await post(`/api/delivery/${delivery}/event`, d, { type: 'reveal' })).status).toBe(403);
  const a = await createPreview(info, p.paths.root, 'album', album, true);
  expect((await post(`/api/album/${album}/event`, a, { type: 'note', text: 'Warm' })).status).toBe(200);
});

it('rejects expired links at HTTP access and cookie exchange', async () => {
  const share = await createPreview(info, p.paths.root, 'album', album, false, 60);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
  try {
    expect((await get(`/api/album/${album}`, share)).status).toBe(403);
    expect((await fetch(base() + '/api/preview/exchange', { method: 'POST', body: JSON.stringify({ token: secret(share), kind: 'album', target: album }) })).status).toBe(403);
  } finally { clock.mockRestore(); }
});

it('opens real mobile album UI, scrubs the URL, seeks with cookie auth and revokes browser access', async () => {
  const share = await createPreview(info, p.paths.root, 'album', album);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(); const requests: string[] = [];
  page.on('request', req => requests.push(req.url() + ' ' + (req.headers().referer ?? '')));
  await page.goto(share.url);
  await page.getByRole('button', { name: 'Demo song', exact: true }).waitFor();
  expect(page.url()).not.toContain('#');
  expect(requests.join('\n')).not.toContain(secret(share)); expect(requests.join('\n')).not.toContain(info.token);
  const cookies = await context.cookies(); expect(cookies[0]).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: `/api/album/${album}` });
  expect(await page.locator('#album-note').isDisabled()).toBe(true);
  await page.getByRole('button', { name: 'Demo song', exact: true }).click();
  expect(await page.locator('#note-here').isDisabled()).toBe(true);
  expect(await page.evaluate(async path => (await fetch(path, { headers: { Range: 'bytes=0-15' } })).status, `/api/album/${album}/wav/1`)).toBe(206);
  expect(foldAlbum(readAlbum(p, album), p).tracks[0].plays).toBe(0);
  await page.reload(); await page.getByRole('button', { name: 'Demo song', exact: true }).waitFor();
  await fetch(`${base()}/api/previews/${share.id}`, { method: 'DELETE', headers: { 'x-beeps-token': info.token } });
  expect(await page.evaluate(async path => (await fetch(path)).status, `/api/album/${album}`)).toBe(403);
  await context.close();
});

it('read-only session playback does not record events; feedback survives reload', async () => {
  const share = await createPreview(info, p.paths.root, 'session', session);
  const context = await browser.newContext(); const page = await context.newPage();
  const count = readEvents(p, session).length;
  await page.goto(share.url); await page.locator('.pad').first().waitFor();
  expect(await page.locator('.mark, .primary').count()).toBe(0);
  await page.locator('.pad').first().click();
  expect(readEvents(p, session).length).toBe(count);
  const feedback = await createPreview(info, p.paths.root, 'album', album, true);
  await page.goto(feedback.url); await page.getByRole('button', { name: 'Demo song', exact: true }).waitFor();
  await page.reload(); await page.getByRole('button', { name: 'Demo song', exact: true }).waitFor();
  expect(await page.locator('#album-note').isEnabled()).toBe(true);
  await context.close();
});


it('advertises Tailscale only when the existing bind and adapter permit it', () => {
  const address = { address: '100.80.1.2', family: 'IPv4', internal: false } as any;
  const interfaces = { Tailscale: [address], Ethernet: [{ ...address, address: '192.168.1.5' }] };
  expect(previewLinks({ host: '0.0.0.0', port: 1234 }, '/s/demo#preview=x', interfaces).url).toBe('http://100.80.1.2:1234/s/demo#preview=x');
  expect(previewLinks({ host: '127.0.0.1', port: 1234 }, '/', interfaces).tailscaleUrl).toBeNull();
  expect(previewLinks({ host: '192.168.1.5', port: 1234 }, '/', interfaces).tailscaleUrl).toBeNull();
  expect(previewLinks({ host: '0.0.0.0', port: 1234 }, '/', { OtherVPN: [address] }).tailscaleUrl).toBeNull();
});


it('preserves owner authority when a browser also has a scoped cookie', async () => {
  const share = await createPreview(info, p.paths.root, 'session', session);
  const response = await fetch(base() + `/api/session/${session}/event`, { method: 'POST', headers: { 'x-beeps-token': info.token, cookie: `beeps_preview=${secret(share)}` }, body: JSON.stringify({ type: 'play', index: 1, mode: '1' }) });
  expect(response.status).toBe(200);
  const scoped = await get(`/api/session/${session}/event`, share, { method: 'POST', headers: { 'x-beeps-token': info.token }, body: JSON.stringify({ type: 'play', index: 1, mode: '1' }) });
  expect(scoped.status).toBe(403);
});

it('rechecks revocation after reading a slow feedback body', async () => {
  const share = await createPreview(info, p.paths.root, 'album', album, true);
  const path = `/api/album/${album}/event`;
  const receiving = new Promise<void>(resolve => server.server.once('request', req => req.once('data', () => resolve())));
  let finish!: () => void;
  const response = new Promise<number>(resolve => {
    const req = httpRequest(base() + path, { method: 'POST', headers: { 'x-beeps-preview': secret(share) } }, res => { res.resume(); resolve(res.statusCode!); });
    req.write('{"type":'); finish = () => req.end('"note","text":"should not save"}');
  });
  await receiving;
  await fetch(`${base()}/api/previews/${share.id}`, { method: 'DELETE', headers: { 'x-beeps-token': info.token } });
  finish(); expect(await response).toBe(403);
  expect(foldAlbum(readAlbum(p, album), p).note).not.toBe('should not save');
});

it('keeps format comparison read-only in the real UI, including after switching tracks', async () => {
  const share = await createPreview(info, p.paths.root, 'delivery', delivery);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(); const writes: string[] = [];
  page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/event')) writes.push(req.url()); });
  await page.goto(share.url); await page.locator('.rate').first().waitFor();
  expect(await page.locator('.rate .scale button').first().isDisabled()).toBe(true);
  expect(await page.locator('#reveal').isDisabled()).toBe(true);
  await page.locator('[data-letter]').last().click();
  expect(await page.locator('.rate .scale button').first().isDisabled()).toBe(true);
  expect(writes).toEqual([]);
  await context.close();
});


it('does not restore preview access on another server using the same owner token', async () => {
  const share = await createPreview(info, p.paths.root, 'album', album);
  const restarted = new AuditionServer({ host: '127.0.0.1', port: 0, token: info.token, projects: [p.paths.root] });
  const fresh = await restarted.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${fresh.port}/api/album/${album}`, { headers: { 'x-beeps-preview': secret(share) } });
    expect(response.status).toBe(403);
  } finally { await restarted.close(); }
});
