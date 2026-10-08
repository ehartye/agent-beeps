import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, type OpenProject } from '../../src/project.ts';
import { writeWav } from '../../src/audio/wav.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { AuditionServer, type ServerInfo } from '../../src/audition/server.ts';
import { createDelivery, foldResults, readDelivery, readDeliveryEvents, resolvePresets, type Encoder } from '../../src/audition/delivery.ts';

// Every "encode" is a WAV copy: decodeAudioData sniffs content, so the page exercises its real playback, switching, rating and reveal path.
const copyEncoder: Encoder = (_f, wav, out) => writeFileSync(out, readFileSync(wav));

describe.skipIf(!(await chromiumAvailable()))('delivery formats page', () => {
  let browser: Browser, server: AuditionServer, info: ServerInfo, p: OpenProject, id: string;
  beforeAll(async () => {
    process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-dpage-home-'));
    p = initProject(mkdtempSync(join(tmpdir(), 'beeps-dpage-')));
    const dir = mkdtempSync(join(tmpdir(), 'beeps-dpage-wav-'));
    const wav = join(dir, 'bed.wav');
    writeFileSync(wav, writeWav([Float32Array.from({ length: 48000 * 6 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 330 * i / 48000))], 48000));
    id = createDelivery(p, [{ name: 'bed', wav, role: 'music', loop: true }], resolvePresets(['mp3-64', 'opus-48', 'anchor']), { encoder: copyEncoder, title: 'Page fixture' }).id;
    server = new AuditionServer({ host: '127.0.0.1', port: 0, token: 'tok', projects: [p.paths.root] });
    info = await server.listen();
    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  it('probes the device, switches letters from the same position, saves ratings and reveals the key', async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('dialog', d => d.accept());
    try {
      await page.goto(`${info.url}/d/${id}?t=tok`);
      await page.getByRole('heading', { name: 'Page fixture' }).waitFor();
      await page.getByText('decodes in').first().waitFor();
      expect(await page.locator('#device tr').count()).toBeGreaterThanOrEqual(2);
      const letters = page.locator('.letter');
      expect(await letters.count()).toBe(4);

      await page.getByRole('button', { name: 'Play bed' }).click();
      await page.getByRole('button', { name: 'Pause bed' }).waitFor();
      await page.waitForFunction(() => /^0:0[1-9]/.test(document.querySelector('[data-act=time]')!.textContent ?? ''));
      await letters.nth(2).click();
      await page.waitForTimeout(150);
      const time = (await page.locator('[data-act=time]').textContent())!;
      expect(time, 'switching letters must not restart the sound').toMatch(/^0:0[1-9]/);
      expect(await letters.nth(2).getAttribute('aria-current')).toBe('true');

      // rate the selected letter, flag it worse
      await page.getByRole('button', { name: /^4\s*good/ }).click();
      await page.getByLabel(/Sounds worse/).check();
      await page.getByLabel('Note on C').fill('smeared top end');
      await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Saved');
      await page.waitForTimeout(900);
      const d = readDelivery(p, id);
      const mine = foldResults(d, readDeliveryEvents(p, id)).rows.find(r => r.letter === 'C')!;
      expect(mine).toMatchObject({ rating: 4, worse: true });
      expect(mine.note).toBe('smeared top end');
      expect(foldResults(d, readDeliveryEvents(p, id)).device).toMatchObject({ canPlayType: expect.anything() });

      await page.getByRole('button', { name: 'Reveal which was which' }).click();
      await page.getByRole('heading', { name: 'Which was which' }).waitFor();
      expect(await page.locator('#revealed').innerText()).toMatch(/WAV master|MP3 CBR 64|Ogg Opus 48/);
      expect(foldResults(d, readDeliveryEvents(p, id)).revealed).toBe(true);
      expect(await page.locator('.rate .scale button').first().isDisabled()).toBe(true);
    } finally { await page.close(); }
  }, 45000);
});
