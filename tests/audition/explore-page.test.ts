import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditionServer, type ServerInfo } from '../../src/audition/server.ts';
import { coin } from '../helpers/patches.ts';

let browser: Browser, server: AuditionServer, info: ServerInfo;
beforeAll(async () => {
  process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-explore-home-'));
  server = new AuditionServer({ host: '127.0.0.1', port: 0, token: 'tok', projects: [] });
  info = await server.listen();
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); await server?.close(); });

it('labels sounds and offers exploration playback without voting controls or voting shortcuts', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let flow = 'explore';
  const events: unknown[] = [];
  await page.route('**/api/session/demo**', route => {
    if (route.request().method() === 'POST') {
      events.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: {
      session: { prompt: 'Explore the ship', family: 'scifi', flow, mode: 'handoff' },
      state: { stage: 'lineup', round: 0, lineup: [1, 2] }, next: [], kit: [], bed: null,
      candidates: [
        { index: 1, name: 'scanner-pulse-260926-3', look: '', words: ['tonal'], seed: 1, trimDb: -3,
          patch: { ...coin(), meta: { description: 'A scanner checking for nearby objects.' } } },
        { index: 2, name: 'shield', look: '', words: [], seed: 1, trimDb: -3, patch: coin() },
      ],
    } });
  });
  await page.goto(`http://127.0.0.1:${info.port}/s/demo?t=tok`);
  await page.getByRole('button', { name: 'Play 1: Scanner pulse' }).waitFor();
  expect(await page.getByText('A scanner checking for nearby objects.', { exact: true }).isVisible()).toBe(true);
  expect(await page.getByText('Shield', { exact: true }).isVisible()).toBe(true);
  expect(await page.locator('#stages').isVisible()).toBe(false);
  expect(await page.locator('.mark, .primary').count()).toBe(0);
  await page.keyboard.press('1');
  await expect.poll(() => events.length).toBe(1);
  await page.keyboard.press('h');
  await page.keyboard.press('x');
  expect(await page.locator('.pad.love, .pad.dud').count()).toBe(0);
  expect(events).toEqual([{ type: 'play', index: 1, mode: '1' }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  flow = 'compare';
  await page.reload();
  await page.getByRole('button', { name: 'Play 1: Scanner pulse' }).waitFor();
  expect(await page.locator('#stages').isVisible()).toBe(true);
  expect(await page.locator('.mark.heart').count()).toBe(2);
  await page.close();
});
