// tests/player/selftest.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import { chromium, firefox, type Browser } from 'playwright';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFfmpeg } from '../../src/compress.ts';
import { chromiumAvailable, serveStatic } from '../../src/render/host.ts';
import { parseSelftestFormats, selftestChannel, writeSelftest } from '../../src/selftest.ts';

const hasFfmpeg = (() => { try { findFfmpeg(); return true; } catch { return false; } })();
const hasChromium = await chromiumAvailable();
const hasFirefox = existsSync(firefox.executablePath());
let server: Server | undefined;
const browsers: Browser[] = [];
afterAll(async () => { for (const b of browsers) await b.close(); server?.close(); });

it('parses --formats and rejects unknown names', () => {
  expect(parseSelftestFormats('opus, mp3')).toEqual(['opus', 'mp3']);
  expect(() => parseSelftestFormats('aac')).toThrow(/aac/);
});

it('synthesises a periodic, non-tonal stereo loop', () => {
  const l = selftestChannel(0, 48000), r = selftestChannel(1, 48000);
  expect(l.length).toBe(96000);
  expect(Math.abs(l[0] - r[0])).toBeGreaterThan(1e-3);
  expect(selftestChannel(0, 44100).length).toBe(88200);
});

describe.skipIf(!hasFfmpeg)('beeps player selftest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-selftest-'));
  const r = writeSelftest(dir);
  it('writes the page, the vendored loader and each encode', () => {
    expect(r.files.sort()).toEqual(['selftest.mp3', 'selftest.ogg', 'selftest.wav']);
    for (const f of [...r.files, 'index.html', 'beeps-player/player/loader.js']) expect(existsSync(join(r.root, f)), f).toBe(true);
    expect(readFileSync(r.index, 'utf8')).toContain("from './beeps-player/player/loader.js'");
  });

  const decodeIn = async (type: typeof chromium) => {
    const site = await serveStatic(r.root);
    server = site.server;
    const browser = await type.launch(); browsers.push(browser);
    const page = await browser.newPage();
    await page.goto(site.url + '/index.html');
    await page.click('#run');
    await page.waitForFunction(() => (window as unknown as { __selftest?: unknown }).__selftest, undefined, { timeout: 60000 });
    return await page.evaluate(() => (window as unknown as { __selftest: { passed: boolean; results: { context: string; file: string; delta?: number; lead?: number; pass?: boolean; error?: string }[] } }).__selftest);
  };

  it.skipIf(!hasChromium)('decodes every format with delta 0 and lead 0 in Chromium', async () => {
    const rep = await decodeIn(chromium);
    expect(rep.results.filter(x => x.error)).toEqual([]);
    expect(rep.results).toHaveLength(9);
    const exact = rep.results.filter(x => x.context.endsWith('@48000'));
    expect(exact.length).toBeGreaterThanOrEqual(6);
    for (const x of exact) { expect(x.delta, `${x.context} ${x.file}`).toBe(0); expect(x.lead).toBe(0); }
    expect(rep.passed).toBe(true);
  }, 90000);

  it.skipIf(!hasFirefox)('reports a result in Firefox too', async () => {
    const rep = await decodeIn(firefox);
    expect(rep.results.length).toBeGreaterThan(0);
    for (const x of rep.results.filter(y => y.context.endsWith('@48000') && y.file !== 'selftest.wav')) expect(x.error ?? x.delta).toBe(x.error ? undefined : 0);
  }, 90000);
});
