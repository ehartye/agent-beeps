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

it.skipIf(!hasChromium)('exported transport holds position beside another owner and owns only terminal analyser edges', async () => {
  const page = await browser!.newPage();
  try {
    await page.goto(`${site!.url}/index.html`);
    const result = await page.evaluate(async () => {
      const dynImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;
      const { createPlayer } = await dynImport('/beeps-player/player/player.js');
      const ctx = new AudioContext(), starts: { when: number; offset: number }[] = [], active = new Set<AudioBufferSourceNode>();
      const original = AudioNode.prototype.connect, make = ctx.createBufferSource.bind(ctx);
      let destinationConnections = 0;
      (AudioNode.prototype as any).connect = function(this: AudioNode, target: AudioNode, ...rest: any[]) {
        if (target === ctx.destination) destinationConnections++;
        return (original as any).call(this, target, ...rest);
      };
      ctx.createBufferSource = () => {
        const n = make(), start = n.start.bind(n);
        n.addEventListener('ended', () => active.delete(n));
        n.start = (when = 0, offset = 0, duration?: number) => {
          starts.push({ when, offset }); active.add(n);
          if (duration === undefined) start(when, offset); else start(when, offset, duration);
        };
        return n;
      };
      // Audio-device startup can lag wall time: sample only after the audio clock has rendered the interval.
      const wait = async (ms: number) => {
        const target = ctx.currentTime + ms / 1000, deadline = performance.now() + 5000;
        while (ctx.currentTime < target && performance.now() < deadline) await new Promise(r => setTimeout(r, 10));
        if (ctx.currentTime < target) throw Error('shared audio clock stopped');
      };
      const rms = (a: AnalyserNode) => { const b = new Float32Array(a.fftSize); a.getFloatTimeDomainData(b); return Math.sqrt(b.reduce((sum, x) => sum + x * x, 0) / b.length); };
      const errors: unknown[] = [], player = createPlayer({ context: ctx, catalog: '/audio/index.json', onError: (e: unknown) => errors.push(e) });
      const other = ctx.createOscillator(), gain = ctx.createGain(), otherMeter = ctx.createAnalyser();
      const tap = ctx.createAnalyser(), secondTap = ctx.createAnalyser();
      other.frequency.value = 440; gain.gain.value = 0.1; other.connect(gain); gain.connect(ctx.destination); gain.connect(otherMeter); other.start();
      try {
        await player.unlock(); await player.music('theme', { fadeSec: 0.01 }); player.setState('danger', { fadeSec: 0.01 });
        const detach = player.attachOutputAnalyser(tap);
        await wait(220); const beforeTap = rms(tap);
        const detachSecond = player.attachOutputAnalyser(secondTap);
        await wait(100); const afterTap = rms(tap), independentTap = rms(secondTap), edges = destinationConnections;
        // Baseline: muting is not a hold.
        const muteStart = player.inspect().music.positionSec; player.setLevel('music', 0); await wait(160);
        const muteAdvance = player.inspect().music.positionSec - muteStart; player.setLevel('music', 1); await wait(50);
        const beforeStop = player.inspect().music.positionSec, restartAt = starts.length;
        await player.music(null, { fadeSec: 0 }); await player.music('theme', { fadeSec: 0.01 });
        const restartOffsets = starts.slice(restartAt).map(s => s.offset);
        player.setState('danger', { fadeSec: 0.01 }); await wait(120);
        const cycles = [];
        for (let i = 0; i < 3; i++) {
          const paused = player.pauseMusic(), position = player.inspect().music.positionSec, clock = ctx.currentTime;
          await wait(180);
          const held = player.inspect().music.positionSec, silence = rms(tap), otherRms = rms(otherMeter), remaining = active.size;
          const at = starts.length, resumed = player.resumeMusic(), scheduled = starts.slice(at);
          await wait(100);
          cycles.push({ paused, position, held, silence, otherRms, remaining, clockAdvance: ctx.currentTime - clock, resumed, scheduled, active: active.size, audible: rms(tap) });
        }
        detach(); const again = player.attachOutputAnalyser(tap); detach(); await wait(60);
        const staleDetachPreserved = rms(tap) > 0.01;
        player.pauseMusic(); gain.gain.value = 0; await wait(80);
        const bothMuted = { music: rms(tap), other: rms(otherMeter) }; gain.gain.value = 0.1;
        player.dispose(); await wait(80);
        again(); detachSecond();
        return { beforeTap, afterTap, independentTap, edges, muteAdvance, beforeStop, restartOffsets, cycles, bothMuted, staleDetachPreserved, activeAfterDispose: active.size, state: ctx.state, otherAfterDispose: rms(otherMeter), errors };
      } finally {
        player.dispose(); other.stop(); other.disconnect(); gain.disconnect(); otherMeter.disconnect(); tap.disconnect(); secondTap.disconnect();
        AudioNode.prototype.connect = original; await ctx.close();
      }
    });
    expect(result.edges).toBe(2); // exactly player + independent owner, never an analyser-to-destination edge
    expect(result.beforeTap, JSON.stringify(result)).toBeGreaterThan(0.01);
    expect(result.afterTap / result.beforeTap).toBeGreaterThan(0.9); expect(result.afterTap / result.beforeTap).toBeLessThan(1.1);
    expect(result.independentTap).toBeCloseTo(result.afterTap, 4); expect(result.muteAdvance).toBeGreaterThan(0.1);
    expect(result.beforeStop).toBeGreaterThan(0.1); expect(result.restartOffsets).toEqual([0, 0, 0]);
    for (const cycle of result.cycles) {
      expect(cycle.paused && cycle.resumed).toBe(true); expect(Math.abs(cycle.held - cycle.position)).toBeLessThan(0.001);
      expect(cycle.silence).toBeLessThan(0.00001); expect(cycle.otherRms).toBeGreaterThan(0.05); expect(cycle.clockAdvance).toBeGreaterThan(0.15);
      expect(cycle.remaining).toBe(0); expect(cycle.active).toBe(3); expect(cycle.audible).toBeGreaterThan(0.01);
      expect(cycle.scheduled).toHaveLength(3);
      for (const s of cycle.scheduled) { expect(s.offset).toBeCloseTo(cycle.position, 5); expect(s.when).toBe(cycle.scheduled[0].when); }
    }
    expect(result.staleDetachPreserved).toBe(true); expect(result.activeAfterDispose).toBe(0);
    expect(result.bothMuted.music).toBeLessThan(0.00001); expect(result.bothMuted.other).toBeLessThan(0.00001);
    expect(result.state).toBe('running'); expect(result.otherAfterDispose).toBeGreaterThan(0.05); expect(result.errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);

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

it.skipIf(!hasChromium).each([44100, 48000])('loads only current state layers and unloads at %i Hz in Chromium', async sampleRate => {
  const page = await browser!.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(`${site!.url}/index.html`);
  const result = await page.evaluate(async sampleRate => {
    const dynImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
    const { createPlayer } = await dynImport('/beeps-player/player/player.js');
    const errors: unknown[] = [];
    const context = new AudioContext({ sampleRate });
    // Compare accounting with the browser's actual resampled buffer, including frame rounding.
    const reference = await context.decodeAudioData(await (await fetch('/audio/theme.bed.wav')).arrayBuffer());
    const expectedBytes = reference.length * reference.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    const player = createPlayer({ context, catalog: '/audio/index.json', memoryBudgetBytes: 8e6, layerLoading: 'state', onError: (e: unknown) => errors.push(e) });
    try {
      await player.unlock();
      await player.music('theme', { fadeSec: 0.1 });
      const calm = player.memory();
      player.setState('danger', { fadeSec: 0.1 });
      for (let i = 0; i < 50 && player.memory().buffers < 3; i++) await new Promise(r => setTimeout(r, 50));
      const danger = player.memory();
      const layers = player.inspect().music.layers;
      await player.music(null, { fadeSec: 0.05 });
      await new Promise(r => setTimeout(r, 400));
      return { calm, danger, layers, expectedBytes, rate: context.sampleRate, freed: player.unload('theme'), after: player.memory(), errors };
    } finally { player.dispose(); if (context.state !== 'closed') await context.close(); }
  }, sampleRate);
  expect(pageErrors).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.rate).toBe(sampleRate);
  expect(Math.abs(result.expectedBytes - 4 * sampleRate * 2 * 4)).toBeLessThanOrEqual(8);
  expect(result.calm).toMatchObject({ buffers: 1, decodedBytes: result.expectedBytes });
  expect(result.danger.buffers).toBe(3);
  expect(result.layers).toEqual({ bed: 1, pulse: 1, threat: 1 });
  expect(result.after.buffers).toBe(0);
});
