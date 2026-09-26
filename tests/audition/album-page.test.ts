import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, type OpenProject } from '../../src/project.ts';
import { foldAlbum, readAlbum, updateAlbumTrack, writeAlbum } from '../../src/album.ts';
import { AuditionServer, type ServerInfo } from '../../src/audition/server.ts';
import { writeWav } from '../../src/audio/wav.ts';
import { chromiumAvailable } from '../../src/render/host.ts';

describe.skipIf(!(await chromiumAvailable()))('album listening page', () => {
let browser: Browser, server: AuditionServer, info: ServerInfo, p: OpenProject;
beforeAll(async () => {
  process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-page-home-'));
  p = initProject(mkdtempSync(join(tmpdir(), 'beeps-page-')));
  server = new AuditionServer({ host: '127.0.0.1', port: 0, token: 'tok', projects: [p.paths.root] });
  info = await server.listen();
  browser = await chromium.launch();
}, 60000);
afterAll(async () => { await browser?.close(); await server?.close(); });

it('keeps transport unavailable until the first song is ready and shows failures without trying to play', async () => {
  const a = writeAlbum(p, { title: 'Not ready yet', tracks: [{ name: 'waiting', title: 'Waiting song', loop: false, status: 'pending' }] });
  const page = await browser.newPage();
  try {
    await page.goto(`${info.url}/a/${a.id}?t=tok`);
    await page.getByText('Preparing your songs', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Play', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Note here', exact: true }).isDisabled()).toBe(true);
    updateAlbumTrack(p, a.id, 1, { status: 'failed', error: 'Missing instrument' });
    await page.getByText('No audio available', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Play', exact: true }).isDisabled()).toBe(true);
    expect(await page.locator('audio').getAttribute('src')).toBeNull();
    await page.getByText('Could not prepare this song: Missing instrument', { exact: true }).waitFor();
  } finally { await page.close(); }
}, 15000);

it('adds finished songs without resetting playback or drafts, skips failures and saves the captured moment', async () => {
  const dir = join(p.paths.renders, 'song-page');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'delivered.wav'), writeWav([new Float32Array(32000 * 60)], 32000));
  writeFileSync(join(dir, 'look.png'), Buffer.from('png'));
  const ready = { name: 'one', title: 'First song', loop: false, durationSec: 60, wav: join(dir, 'delivered.wav'), look: join(dir, 'look.png'), renderKey: 'render-page', sections: [{ name: 'opening', start: 0, end: 30 }, { name: 'return', start: 30, end: 60 }], features: {} };
  const a = writeAlbum(p, { title: 'Arriving songs', tracks: [ready, { name: 'two', title: 'Second song', loop: false, status: 'pending' }, { name: 'three', title: 'Failed song', loop: false, status: 'failed', error: 'render failed' }] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  try {
    // Keep whole-track/album drafts unsaved while a poll arrives, as on a flaky connection.
    await page.route('**/event?*', route => route.request().postDataJSON().type === 'note' ? route.abort() : route.continue());
    await page.goto(`${info.url}/a/${a.id}?t=tok`);
    await page.getByRole('button', { name: 'First song', exact: true }).click();
    await page.waitForFunction(() => !(document.querySelector('audio') as HTMLAudioElement).paused);
    await page.evaluate(() => { (document.querySelector('audio') as HTMLAudioElement).currentTime = 35; });
    await page.getByRole('button', { name: 'Note here', exact: true }).click();
    await page.getByLabel('Moment note').fill('This return works');
    await page.getByLabel('Notes on First song').fill('still writing');
    await page.getByLabel('Notes on the whole album').fill('album draft');
    const before = await page.locator('audio').evaluate((a: HTMLAudioElement) => ({ src: a.src, at: a.currentTime }));
    updateAlbumTrack(p, a.id, 2, { ...ready, status: 'ready', renderKey: 'render-two' });
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.track[data-index="2"] h2 button')?.disabled === false);
    expect(await page.getByLabel('Notes on First song').inputValue()).toBe('still writing');
    expect(await page.getByLabel('Notes on the whole album').inputValue()).toBe('album draft');
    expect(await page.getByLabel('Moment note').inputValue()).toBe('This return works');
    const after = await page.locator('audio').evaluate((a: HTMLAudioElement) => ({ src: a.src, at: a.currentTime, paused: a.paused }));
    expect(after.src).toBe(before.src);
    expect(after.at).toBeGreaterThanOrEqual(before.at);
    expect(after.paused).toBe(false);
    await page.getByRole('button', { name: 'Save moment', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.moments')?.textContent?.includes('This return works'));
    const moment = foldAlbum(readAlbum(p, a.id), p).tracks[0].moments[0];
    expect(moment).toMatchObject({ text: 'This return works', section: 'return', renderKey: 'render-page' });
    expect(moment.pos).toBeGreaterThanOrEqual(35);
    expect(moment.pos).toBeLessThan(after.at);
    await page.getByRole('button', { name: 'Next track', exact: true }).click();
    await page.getByRole('button', { name: 'Next track', exact: true }).click();
    expect(await page.locator('#np-title').textContent()).toBe('First song');
    expect(await page.getByRole('button', { name: 'Failed song', exact: true }).isDisabled()).toBe(true);
    await page.reload();
    await page.getByText('This return works', { exact: true }).waitFor();
  } finally { await page.close(); }
}, 30000);
});
