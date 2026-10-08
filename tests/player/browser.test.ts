// tests/player/browser.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumAvailable, serveStatic } from '../../src/render/host.ts';
import { exportPlayer } from '../../src/commands/player.ts';
import { writeWav } from '../../src/audio/wav.ts';

const hasChromium = await chromiumAvailable();
let browser: Browser | undefined, site: { server: Server; url: string } | undefined, siteDir: string | undefined;
const tone = (sec: number, hz: number) => {
  const n = Math.round(48000 * sec), c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = 0.25 * Math.sin((2 * Math.PI * hz * i) / 48000);
  return writeWav([c, c], 48000);
};

beforeAll(async () => {
  if (!hasChromium) return;
  const dir = mkdtempSync(join(tmpdir(), 'beeps-player-site-'));
  siteDir = dir;
  exportPlayer(dir);
  mkdirSync(join(dir, 'audio'));
  // coin is a full second so it is still sounding (voices: 1) when inspect() is read right after play().
  for (const [f, sec, hz] of [['coin.wav', 1, 880], ['theme.wav', 4, 110], ['theme.bed.wav', 4, 110], ['theme.pulse.wav', 4, 220], ['theme.threat.wav', 4, 330]] as const) {
    writeFileSync(join(dir, 'audio', f), tone(sec, hz));
  }
  writeFileSync(join(dir, 'audio', 'index.json'), JSON.stringify({ schema: 'beeps/audio-bundle@1', assets: {
    coin: { file: 'coin.wav', loop: false, priority: 3 },
    theme: { file: 'theme.wav', loop: true, bpm: 120, meter: 4, durationSec: 4,
      layers: [{ name: 'bed', file: 'theme.bed.wav' }, { name: 'pulse', file: 'theme.pulse.wav' }, { name: 'threat', file: 'theme.threat.wav' }],
      states: { calm: ['bed'], danger: ['bed', 'pulse', 'threat'] }, initialState: 'calm' },
  } }));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>player</title>');
  site = await serveStatic(dir);
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});
afterAll(async () => {
  await browser?.close();
  if (site) await new Promise<void>(r => site!.server.close(() => r()));
  if (siteDir) rmSync(siteDir, { recursive: true, force: true });
});

it.skipIf(!hasChromium)('plays a bundle through the vendored player in Chromium', async () => {
  const page = await browser!.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(`${site!.url}/index.html`);
  const result = await page.evaluate(async () => {
    // Indirect: a literal `import(...)` here would be rewritten by vitest's Vite SSR transform to
    // `__vite_ssr_dynamic_import__`, which page.evaluate serializes as source text and sends to the
    // page, where that helper does not exist. Building the importer from a string in the browser
    // dodges that static rewrite.
    const dynImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
    const { createPlayer } = await dynImport('/beeps-player/player/player.js');
    const errors: unknown[] = [];
    const player = createPlayer({ catalog: '/audio/index.json', voices: 4, onError: (e: unknown) => errors.push(e) });
    await player.unlock();
    const started = await player.music('theme', { fadeSec: 0.1 });
    const played = await player.play('coin').ready;
    const before = player.inspect();
    player.setState('danger', { fadeSec: 0.1 });
    return { started, played, before, after: player.inspect(), errors };
  });
  expect(pageErrors).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result).toMatchObject({
    started: true, played: true,
    before: { running: true, voices: 1, music: { id: 'theme', state: 'calm', layers: { bed: 1, pulse: 0, threat: 0 } } },
    after: { music: { state: 'danger', layers: { bed: 1, pulse: 1, threat: 1 } } },
  });
});

it.skipIf(!hasChromium)('the master clipper passes signals below its knee through unchanged', async () => {
  const page = await browser!.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(`${site!.url}/index.html`);
  const maxDiff = await page.evaluate(async () => {
    // See the note in the previous test: indirect import avoids the Vite SSR dynamic-import rewrite.
    const dynImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
    const { clipperCurve } = await dynImport('/beeps-player/engine/fx.js');
    const ctx = new OfflineAudioContext(1, 48000, 48000);
    const buf = ctx.createBuffer(1, 48000, 48000);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.8 * Math.sin((2 * Math.PI * 441 * i) / 48000); // under the -1.5 dBFS knee (0.841)
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const shaper = ctx.createWaveShaper();
    shaper.curve = clipperCurve();
    shaper.oversample = 'none';
    src.connect(shaper).connect(ctx.destination);
    src.start();
    const out = (await ctx.startRendering()).getChannelData(0);
    let m = 0;
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(out[i] - d[i]));
    return m;
  });
  expect(pageErrors).toEqual([]);
  expect(maxDiff).toBeLessThan(1e-6);
});

it.skipIf(!hasChromium)('loads only the current state layers under a memory budget, and unloads, in Chromium', async () => {
  const page = await browser!.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(`${site!.url}/index.html`);
  const result = await page.evaluate(async () => {
    const dynImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
    const { createPlayer } = await dynImport('/beeps-player/player/player.js');
    const errors: unknown[] = [];
    const player = createPlayer({ catalog: '/audio/index.json', memoryBudgetBytes: 8e6, layerLoading: 'state', onError: (e: unknown) => errors.push(e) });
    await player.unlock();
    await player.music('theme', { fadeSec: 0.1 });
    const calm = player.memory();
    player.setState('danger', { fadeSec: 0.1 });
    for (let i = 0; i < 50 && player.memory().buffers < 3; i++) await new Promise(r => setTimeout(r, 50));
    const danger = player.memory();
    const layers = player.inspect().music.layers;
    await player.music(null, { fadeSec: 0.05 });
    await new Promise(r => setTimeout(r, 400));
    return { calm, danger, layers, freed: player.unload('theme'), after: player.memory(), errors };
  });
  expect(pageErrors).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.calm).toMatchObject({ buffers: 1, decodedBytes: 4 * 48000 * 2 * 4 });
  expect(result.danger.buffers).toBe(3);
  expect(result.layers).toEqual({ bed: 1, pulse: 1, threat: 1 });
  expect(result.after.buffers).toBe(0);
});
