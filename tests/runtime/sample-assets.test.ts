import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as runtime from '../../runtime/engine/index.js';
import type { SampleAssetManifest } from '../../runtime/engine/index.js';
import { ENGINE_VERSION } from '../../runtime/engine/version.js';
import { writeWav } from '../../src/audio/wav.ts';
import { sampleId } from '../../src/samples/store.ts';
import { RUNTIME_DIR, serveStatic, chromiumAvailable } from '../../src/render/host.ts';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { withSource } from '../helpers/patches.ts';

const wav = writeWav([new Float32Array([0.125, -0.25, 0.5]), new Float32Array([-0.5, 0.25, -0.125])], 48000, { bits: 32 });
const id = sampleId(wav), other = `sha256:${'0'.repeat(64)}`;
const patch = () => withSource({ type: 'sample', asset: id });
const manifest = () => ({ [id]: { file: 'sample.wav', bytes: wav.length, sampleRate: 48000 as const, channels: 2 as const, frames: 3 } });
const cue = () => ({ schema: 'beeps/runtime-cue@1', id: 'test', engine: ENGINE_VERSION, seed: 1, trimDb: 0, patch: patch(), assets: manifest() });
const samples = () => import('../../runtime/engine/samples.js');

describe('portable sample asset manifest', () => {
  it('exports the asynchronous loader from the runtime entry', () => expect(runtime).toHaveProperty('loadCueAssets', expect.any(Function)));
  it('accepts the exact unique dependency closure and legacy cues', () => {
    expect(runtime.parseCue(cue())).toEqual(cue());
    const pure = { ...cue(), patch: withSource({ type: 'noise' }), assets: {} };
    expect(runtime.parseCue(pure)).toBe(pure);
    const { assets: _, ...old } = pure;
    expect(runtime.parseCue(old)).toBe(old);
  });
  it.each(['../x.wav', '/x.wav', 'a/b.wav', 'a\\b.wav', 'https://x/a.wav', 'x.wav?q', 'x.wav#x', '%2e%2e.wav', '..wav', 'x.mp3', 'C:x.wav'])('rejects unsafe or non-WAV file %s', file => expect(() => runtime.parseCue({ ...cue(), assets: { [id]: { ...manifest()[id], file } } })).toThrow(/sample.*file/i));
  it.each([{ bytes: Infinity }, { bytes: 1.1 }, { bytes: 43 }, { bytes: 4_000_000 }, { sampleRate: 44100 }, { channels: 3 }, { frames: 0 }, { frames: 480001 }, { frames: NaN }, { frames: 1.5 }])('rejects invalid metadata %j', bad => expect(() => runtime.parseCue({ ...cue(), assets: { [id]: { ...manifest()[id], ...bad } } })).toThrow(/sample/i));
  it('rejects missing, extra, invalid IDs and duplicate files', () => {
    for (const assets of [undefined, {}, { ...manifest(), [other]: manifest()[id] }, { 'file.wav': manifest()[id] }]) expect(() => runtime.parseCue({ ...cue(), assets })).toThrow(/sample/i);
    const p = patch(); p.layers.push(withSource({ type: 'sample', asset: other }).layers[0]);
    expect(() => runtime.parseCue({ ...cue(), patch: p, assets: { ...manifest(), [other]: manifest()[id] } })).toThrow(/duplicate.*file|file.*unique/i);
  });
});

describe('verified sample preparation', () => {
  it('hashes exact byte ranges with bundled SHA256 against Node vectors and prepared WAV bytes', async () => {
    const { sampleHash } = await import('../../runtime/engine/sample-hash.js');
    for (const bytes of [new Uint8Array(), new TextEncoder().encode('abc'), new Uint8Array(1_000_000).fill(97), wav, randomBytes(8193).subarray(7, 8189)]) expect(sampleHash(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
  it('can reproduce its committed flat hash module', () => expect(execFileSync(process.execPath, ['scripts/vendor-sample-hash.mjs', '--check'], { cwd: RUNTIME_DIR + '/..', encoding: 'utf8' })).toMatch(/up to date/i));
  it('verifies keyed bytes and copies exact stereo PCM without a platform decoder', async () => {
    const { prepareSampleWavs } = await samples();
    const f = new FakeContext();
    const buffers = prepareSampleWavs(asCtx(f), patch(), { [id]: wav });
    expect(Object.keys(buffers)).toEqual([id]);
    expect(Array.from(buffers[id].getChannelData(0))).toEqual([0.125, -0.25, 0.5]);
    expect(Array.from(buffers[id].getChannelData(1))).toEqual([-0.5, 0.25, -0.125]);
    expect(buffers[id].sampleRate).toBe(48000);
    for (const input of [{}, { [id]: wav, [other]: wav }, { [id]: Uint8Array.from(wav, (b, i) => i === 50 ? b ^ 1 : b) }]) expect(() => prepareSampleWavs(asCtx(f), patch(), input)).toThrow(/sample|hash/i);
    const invalid = Buffer.from(wav); invalid.writeFloatLE(Infinity, 44);
    expect(() => prepareSampleWavs(asCtx(f), withSource({ type: 'sample', asset: sampleId(invalid) }), { [sampleId(invalid)]: invalid })).toThrow(/finite/i);
  });
  it('resolves file names against the explicit cue URL and forwards cancellation', async () => {
    const { loadCueAssets } = await samples();
    const f = new FakeContext(), controller = new AbortController();
    const fetcher = vi.fn(async () => new Response(new Uint8Array(wav)));
    const got = await loadCueAssets(asCtx(f), { patch: patch(), assets: manifest() }, { baseURL: 'http://lan.test/audio/test.runtime.json', fetcher, signal: controller.signal });
    expect(fetcher.mock.calls[0]).toEqual(['http://lan.test/audio/sample.wav', { signal: controller.signal }]);
    expect(got[id].length).toBe(3);
    const fail = (response: Response, assets: SampleAssetManifest = manifest()) => loadCueAssets(asCtx(f), { patch: patch(), assets }, { baseURL: 'http://lan.test/audio/test.runtime.json', fetcher: async () => response });
    await expect(fail(new Response(null, { status: 404 }))).rejects.toThrow(/404|fetch/i);
    await expect(fail(new Response(Uint8Array.from(wav, b => b ^ 1)))).rejects.toThrow(/hash/i);
    await expect(fail(new Response(new Uint8Array(wav)), { [id]: { ...manifest()[id], frames: 4, bytes: 76 } })).rejects.toThrow(/metadata|bytes/i);
    await expect(fail(new Response(new Uint8Array(wav)), { [id]: { ...manifest()[id], channels: 1, frames: 6 } })).rejects.toThrow(/metadata.*canonical/i);
    controller.abort();
    await expect(loadCueAssets(asCtx(f), { patch: patch(), assets: manifest() }, { baseURL: 'http://lan.test/cue.json', signal: controller.signal })).rejects.toThrow(/abort/i);
  });
  it('cancels an oversized body as soon as it exceeds the exact manifest byte bound', async () => {
    const { loadCueAssets } = await samples();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(wav.length + 1)); }, cancel() { cancelled = true; } });
    const controller = new AbortController();
    const response = new Response(body); // no Content-Length; stream never closes on its own
    const pending = loadCueAssets(asCtx(new FakeContext()), { patch: patch(), assets: manifest() }, { baseURL: 'http://lan.test/cue.json', signal: controller.signal, fetcher: async () => response });
    // A stuck unbounded arrayBuffer read must fail this test promptly instead of hanging the suite.
    const timeout = setTimeout(() => controller.abort(), 500);
    try {
      await expect(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('unbounded body read')), 1000))])).rejects.toThrow(/byte.*bound|byte.*exceed|byte.*overflow/i);
      expect(cancelled).toBe(true);
    } finally { clearTimeout(timeout); await body.cancel().catch(() => {}); }
  });
});

describe.skipIf(!(await chromiumAvailable()))('actual HTTP LAN loading without WebCrypto', () => {
  let browser: Browser, page: Page, site: Awaited<ReturnType<typeof serveStatic>>;
  let excessCancelled = false;
  beforeAll(async () => {
    site = await serveStatic(RUNTIME_DIR, { extra(req, res) {
      if (req.url === '/test.html') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html>'); return true; }
      if (req.url === '/sample.wav' || req.url === '/bad.wav') { res.setHeader('content-type', 'audio/wav'); res.end(req.url === '/sample.wav' ? wav : Buffer.from(wav).fill(0, 44)); return true; }
      if (req.url === '/slow.wav') { const timer = setTimeout(() => res.end(wav), 10_000); res.on('close', () => clearTimeout(timer)); return true; }
      if (req.url === '/excess.wav') {
        res.writeHead(200, { 'content-type': 'audio/wav' }); res.write(Buffer.concat([wav, Buffer.alloc(256)]));
        const timer = setInterval(() => res.write(Buffer.alloc(65536)), 10);
        res.on('close', () => { excessCancelled = true; clearInterval(timer); });
        return true;
      }
      return false;
    } });
    browser = await chromium.launch({ args: ['--host-resolver-rules=MAP beeps-lan.test 127.0.0.1', '--no-proxy-server'] });
    page = await browser.newPage(); await page.goto(`http://beeps-lan.test:${site.port}/test.html`);
  });
  afterAll(async () => { await browser?.close(); if (site) await new Promise<void>(resolve => site.server.close(() => resolve())); });
  it('loads real fetched WAV bytes, refuses corruption/404/metadata mismatch and cancels fetch', async () => {
    const result = await page.evaluate(async ({ source, id }) => {
      const load = new Function('path', 'return import(path)') as (path: string) => Promise<any>;
      const { loadCueAssets } = await load('/engine/index.js');
      const ctx = new OfflineAudioContext(2, 480, 48000);
      const options = { baseURL: location.href };
      const buffers = await loadCueAssets(ctx, source, options);
      const errors: string[] = [];
      for (const change of [{ file: 'bad.wav' }, { file: 'absent.wav' }, { channels: 1, bytes: 56 }, { file: 'excess.wav' }]) {
        try { await loadCueAssets(ctx, { ...source, assets: { [id]: { ...source.assets[id], ...change } } }, options); } catch (e) { errors.push(String(e)); }
      }
      const controller = new AbortController();
      const pending = loadCueAssets(ctx, { ...source, assets: { [id]: { ...source.assets[id], file: 'slow.wav' } } }, { ...options, signal: controller.signal });
      setTimeout(() => controller.abort(), 25);
      try { await pending; } catch (e) { errors.push(String(e)); }
      return { secure: isSecureContext, subtle: typeof crypto.subtle, pcm: [...buffers[id].getChannelData(1)], errors };
    }, { source: { patch: patch(), assets: manifest() }, id });
    expect(result.secure).toBe(false); expect(result.subtle).toBe('undefined');
    expect(result.pcm).toEqual([-0.5, 0.25, -0.125]);
    expect(result.errors).toHaveLength(5);
    expect(result.errors[0]).toMatch(/hash/i); expect(result.errors[1]).toMatch(/404/); expect(result.errors[2]).toMatch(/bytes|metadata/i); expect(result.errors[3]).toMatch(/byte.*bound|byte.*exceed|byte.*overflow/i); expect(result.errors[4]).toMatch(/abort/i);
    await vi.waitFor(() => expect(excessCancelled).toBe(true));
  });
});
