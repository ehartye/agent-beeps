import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { initProject, type OpenProject } from '../../src/project.ts';
import { writeWav } from '../../src/audio/wav.ts';
import { patchSampleIds, writeSampleObject, samplePaths, type ResolvedSample } from '../../src/samples/store.ts';
import { patch } from '../helpers/patches.ts';
import { writeKit } from '../../src/kit.ts';
import { openSession, readEvents } from '../../src/audition/session.ts';
import { AuditionServer, type ServerInfo } from '../../src/audition/server.ts';
import { readSet, setCandidatePatch, type CandidateSet } from '../../src/sets.ts';
import { openRenderHost } from '../../src/render/host.ts';
import { lintPatch } from '../../src/lint.ts';
import { measure, type Features } from '../../src/measure/index.ts';

let p: OpenProject, server: AuditionServer, info: ServerInfo, browser: Browser, set: CandidateSet;
let id: string, noKit: string, source: ResolvedSample, kitSource: ResolvedSample, kitSecond: ResolvedSample, unrelated: ResolvedSample;
const token = 'sample-test';
const api = (path: string, auth = true) => fetch(`${info.url}${path}`, { headers: auth ? { 'x-beeps-token': token } : {} });
const assetPath = (sid: string, obj: ResolvedSample) => `/api/session/${sid}/assets/${obj.id.slice(7)}.wav`;

beforeAll(async () => {
  process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-sample-page-home-'));
  p = initProject(mkdtempSync(join(tmpdir(), 'beeps-sample-page-')));
  const makeSource = (hz: number) => writeSampleObject(samplePaths(p).objects, writeWav([Float32Array.from({ length: 7680 }, (_, i) => Math.sin(i * 2 * Math.PI * hz / 48000) * .1 * Math.min(1, i / 480, (7679 - i) / 480))], 48000, { bits: 32 }));
  source = makeSource(330); kitSource = makeSource(550); kitSecond = makeSource(660); unrelated = makeSource(880);
  const sample = patch({ schema: 'beeps/patch@1', name: 'recording', family: 'sfx', duration: .16,
    layers: [{ source: { type: 'sample', asset: source.id }, amp: { attack: 0, decay: 0, sustain: 1, release: 0 } }] });
  const hybrid = patch({ ...sample, name: 'hybrid', layers: [...sample.layers, { source: { type: 'osc', wave: 'sine', pitch: 1200 }, gainDb: -24, amp: { attack: .005, decay: .1, sustain: 0, release: .02 } }] });
  const kit = patch({ ...sample, name: 'kit-tap', layers: [{ ...sample.layers[0], source: { type: 'sample', asset: kitSource.id } }] });
  const kit2 = patch({ ...kit, name: 'kit-second', layers: [{ ...kit.layers[0], source: { type: 'sample', asset: kitSecond.id } }] });
  for (const x of [sample, hybrid, kit, kit2]) writeFileSync(join(p.paths.patches, `${x.name}.json`), JSON.stringify(x));
  writeKit(p.paths.root, { schema: 'beeps/kit@1', sounds: [kit, kit2].map(x => ({ name: x.name, family: x.family, priority: 1, trimDb: -7, seed: 1 })) });
  const cli = spawnSync(process.execPath, [join(import.meta.dirname, '../../scripts/beeps.mjs'), 'set', 'create', 'recording', 'hybrid', '--name', 'sample-acceptance'], { cwd: p.paths.root, encoding: 'utf8', windowsHide: true });
  expect(cli.status, cli.stderr).toBe(0);
  set = readSet(p, JSON.parse(cli.stdout).set);
  expect(set.candidates.every(c => Number.isFinite(c.features.attackSec) && readFileSync(c.wav).length > 44)).toBe(true);
  id = openSession(p, set.id, { flow: 'explore', requirePrediction: false, context: { kit: true, bed: false } }).id;
  noKit = openSession(p, set.id, { flow: 'explore', requirePrediction: false, context: { kit: false, bed: false } }).id;
  server = new AuditionServer({ host: '127.0.0.1', port: 0, token, projects: [p.paths.root] });
  info = await server.listen(); browser = await chromium.launch();
}, 120000);
afterAll(async () => { await browser?.close(); await server?.close(); });

it('serves exact verified candidate and enabled kit manifests over authenticated session assets', async () => {
  const payload = await (await api(`/api/session/${id}`)).json();
  const entry = (s: ResolvedSample) => ({ file: `${s.id.slice(7)}.wav`, sampleRate: 48000, channels: s.channels, frames: s.frames, bytes: s.bytes });
  for (const c of payload.candidates) expect(c.assets).toEqual({ [source.id]: entry(source) });
  expect(payload.kit[0].assets).toEqual({ [kitSource.id]: entry(kitSource) });
  for (const s of [source, kitSource]) {
    const r = await api(assetPath(id, s)); expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/wav');
    expect(Buffer.from(await r.arrayBuffer())).toEqual(s.wav);
  }
  expect((await api(assetPath(id, source), false)).status).toBe(401);
  expect((await api(assetPath(id, unrelated))).status).toBe(404);
  expect((await api(assetPath(noKit, kitSource))).status).toBe(404);
  expect((await api(`/api/session/${id}/assets/..%2f${source.id.slice(7)}.wav`)).status).toBe(404);
  expect((await api(`/api/session/${id}/assets/${'F'.repeat(64)}.wav`)).status).toBe(404);
});

async function expectSampleError(status: number, code: string) {
  for (const path of [`/api/session/${id}`, assetPath(id, source)]) {
    const r = await api(path); expect(r.status).toBe(status);
    const body = await r.json();
    expect(body.error).toMatchObject({ code, message: expect.stringContaining(source.id) });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(p.paths.root);
    expect(serialized).not.toContain(source.path);
    expect(serialized).not.toMatch(/\.agent-beeps|[A-Za-z]:|\\\\|"path"/);
  }
}

it.each([
  { kind: 'corrupt', status: 500, code: 'E_VERIFY' },
  { kind: 'missing', status: 404, code: 'E_NOT_FOUND' },
  { kind: 'oversized', status: 400, code: 'E_SCHEMA' },
])('keeps $kind sample diagnostics private in payload and asset errors after warm reads', async ({ kind, status, code }) => {
  expect((await api(`/api/session/${id}`)).status).toBe(200);
  expect((await api(assetPath(id, source))).status).toBe(200);
  if (kind === 'missing') unlinkSync(source.path);
  else if (kind === 'oversized') writeFileSync(source.path, Buffer.alloc(44 + 480000 * 2 * 4 + 1));
  else { const bad = Buffer.from(source.wav); bad[44] ^= 1; writeFileSync(source.path, bad); }
  try { await expectSampleError(status, code); }
  finally { writeFileSync(source.path, source.wav); }
});

// Intercept only construction: every node, buffer, filter and rendered sample remains native.
async function offlinePage(seconds = 5, suspended = false) {
  const page = await browser.newPage();
  await page.addInitScript(({ seconds, suspended }) => {
    const native = OfflineAudioContext;
    (window as any).AudioContext = function () {
      const ctx = new native(2, seconds * 48000, 48000);
      Object.defineProperty(ctx, 'state', { get: () => suspended ? 'suspended' : 'running' });
      const make = ctx.createBufferSource.bind(ctx);
      const starts: number[] = [], buffers: AudioBuffer[] = [];
      ctx.createBufferSource = () => {
        const node = make(), start = node.start.bind(node);
        node.start = (when = 0, ...rest: [number?, number?]) => { starts.push(when); buffers.push(node.buffer!); start(when, ...rest); };
        return node;
      };
      (window as any).nativeAudio = { ctx, starts, buffers };
      if (suspended) ctx.resume = () => new Promise<void>(resolve => { (window as any).nativeAudio.resume = resolve; });
      return ctx;
    };
  }, { seconds, suspended });
  return page;
}
async function visit(page: Page, url = info.url) {
  await page.goto(`${url}/s/${id}?t=${token}`);
  await page.locator('.face').first().waitFor();
}

it.each([
  { index: 1, count: 1, kit: false, phone: false },
  { index: 2, count: 1, kit: false, phone: false },
  { index: 1, count: 1, kit: true, phone: false },
  { index: 1, count: 5, kit: true, phone: true },
])('plays actual set PCM through the current UI at measured trim: %j', async ({ index, count, kit, phone }) => {
  const page = await offlinePage();
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  let requests = 0; page.on('request', r => { if (r.url().includes('/assets/')) requests++; });
  await visit(page);
  if (count === 5) await page.locator('[data-repeat="5"]').click();
  if (kit) await page.locator('#withKit').click();
  if (phone) await page.locator('[data-speaker="phone"]').click();
  await page.locator(`.pad[data-index="${index}"] .face`).click();
  await expect.poll(async () => ({ playing: await page.locator('.pad.playing').count(), errors })).toEqual({ playing: 1, errors: [] });
  const actual = await page.evaluate(async () => {
    const { ctx, starts, buffers } = (window as any).nativeAudio;
    const out: AudioBuffer = await ctx.startRendering();
    return { pcm: [Array.from(out.getChannelData(0)), Array.from(out.getChannelData(1))], starts, buffers: new Set(buffers).size };
  });
  expect(actual.starts).toHaveLength(count * (kit ? 2 : 1));
  expect(actual.buffers).toBe(kit ? Math.min(count, 2) + 1 : 1);
  expect(requests).toBe(kit ? Math.min(count, 2) + 1 : 1);
  const c = set.candidates[index - 1], host = await openRenderHost();
  let reference: number[][][];
  try {
    const payload = await (await api(`/api/session/${id}`)).json();
    const sources = [payload.candidates[index - 1], ...(kit ? payload.kit.slice(0, count) : [])];
    const wavs = new Map([source, kitSource, kitSecond].map(s => [s.id, s.wav.toString('base64')]));
    const rendered = await host.render(sources.map(x => ({ patch: x.patch, opts: { seed: x.seed, trimDb: x.trimDb, scale: p.project.scale, sampleWavs: Object.fromEntries(patchSampleIds(x.patch).map(id => [id, wavs.get(id)!])) } })));
    reference = rendered.map(r => { if (!r.ok) throw new Error(r.error); return r.delivered.map(ch => Array.from(ch)); });
    // Changed source must change the production recording path; noise/seed alone is no control.
    if (index === 1 && !kit) {
      const changed = setCandidatePatch(p, set.id, c.name); changed.layers[0].source = { type: 'sample', asset: unrelated.id };
      const [r] = await host.render([{ patch: changed, opts: { seed: c.seed, trimDb: c.trimDb, scale: p.project.scale, sampleWavs: { [unrelated.id]: unrelated.wav.toString('base64') } } }]);
      expect(r.ok && r.delivered[0].some((x, i) => Math.abs(x - reference[0][0][i]) > .01)).toBe(true);
    }
  } finally { await host.close(); }
  const expected = await page.evaluate(async ({ reference, count, kit, phone }) => {
    const ctx = new OfflineAudioContext(2, 5 * 48000, 48000), bus = ctx.createGain(); let out: AudioNode = bus;
    if (phone) for (const f of [{ type: 'highpass', frequency: 450, Q: .9 }, { type: 'peaking', frequency: 2500, Q: 1, gain: 4 }, { type: 'lowpass', frequency: 9000, Q: .7 }]) {
      const filter = ctx.createBiquadFilter(); filter.type = f.type as BiquadFilterType; filter.frequency.value = f.frequency; filter.Q.value = f.Q; filter.gain.value = f.gain ?? 0; out.connect(filter); out = filter;
    }
    out.connect(ctx.destination);
    const play = (pcm: number[][], when: number) => {
      const buffer = ctx.createBuffer(2, pcm[0].length, 48000); pcm.forEach((ch, i) => buffer.copyToChannel(new Float32Array(ch), i));
      const src = ctx.createBufferSource(); src.buffer = buffer; src.connect(bus); src.start(when);
    };
    let t = .05;
    for (let i = 0; i < count; i++) { if (kit) { play(reference[1 + i % (reference.length - 1)], t); t += .5; } play(reference[0], t); t += .4; }
    const result = await ctx.startRendering(); return [Array.from(result.getChannelData(0)), Array.from(result.getChannelData(1))];
  }, { reference, count, kit, phone });
  let max = 0; for (let ch = 0; ch < 2; ch++) for (let i = 0; i < expected[ch].length; i++) max = Math.max(max, Math.abs(expected[ch][i] - actual.pcm[ch][i]));
  expect(max).toBeLessThan(1e-6);
  expect(readEvents(p, id).filter(e => e.type === 'play').at(-1)).toMatchObject({ type: 'play', index, mode: `${count}${kit ? '+kit' : ''}` });
  await page.close();
}, 60000);

it.each(['stop', 'selection'])('cancels an obsolete native UI play during real delayed asset HTTP: %s', async action => {
  let release!: () => void, seen!: () => void, aborted = false;
  const held = new Promise<void>(r => { release = r; }), requested = new Promise<void>(r => { seen = r; });
  let first = true;
  const proxy = createServer(async (req, res) => {
    const upstream = await fetch(`${info.url}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(req.method === 'POST' ? { body: await new Promise<string>(r => { const chunks: Buffer[] = []; req.on('data', c => chunks.push(c)); req.on('end', () => r(Buffer.concat(chunks).toString('utf8'))); }) } : {}) });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (req.url?.includes('/assets/') && first) { first = false; res.on('close', () => { aborted = true; }); seen(); await held; }
    if (!res.destroyed) { res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type')! }); res.end(body); }
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const page = await offlinePage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const before = readEvents(p, id).filter(e => e.type === 'play').length;
  try {
    await visit(page, `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
    await page.locator('.pad[data-index="1"] .face').click();
    await Promise.race([requested, new Promise((_, reject) => setTimeout(() => reject(new Error(`asset HTTP never started: ${errors}`)), 3000))]);
    if (action === 'stop') await page.locator('#stop').click();
    else await page.locator('.pad[data-index="2"] .face').click();
    await expect.poll(() => aborted).toBe(true);
    if (action === 'selection') await expect.poll(() => readEvents(p, id).filter(e => e.type === 'play').length).toBe(before + 1);
    release();
    // A subsequent authenticated round trip ensures the held request was released before assertions.
    await page.evaluate(async () => { await fetch(`/api/session/${location.pathname.split('/').pop()}?${location.search.slice(1)}`); await new Promise(r => setTimeout(r, 50)); });
    expect(await page.evaluate(() => (window as any).nativeAudio.starts.length)).toBe(action === 'stop' ? 0 : 1);
    expect(await page.locator('.pad.playing').count()).toBe(action === 'stop' ? 0 : 1);
    if (action === 'selection') expect(await page.locator('.pad.playing').getAttribute('data-index')).toBe('2');
    expect(await page.locator('#toast.show').count()).toBe(0);
    expect(errors).toEqual([]);
    const events = readEvents(p, id).filter(e => e.type === 'play').slice(before);
    expect(events).toMatchObject(action === 'stop' ? [] : [{ type: 'play', index: 2 }]);
  } finally { release(); await page.close(); await new Promise<void>(r => proxy.close(() => r())); }
}, 15000);

it('starts fetched sample audio in an ordinary real-time native AudioContext', async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const Native = AudioContext;
    (window as any).AudioContext = function (opts: AudioContextOptions) {
      const ctx = new Native(opts), make = ctx.createBufferSource.bind(ctx);
      (window as any).realAudio = { ctx, starts: 0 };
      ctx.createBufferSource = () => { const node = make(), start = node.start.bind(node); node.start = (...args: Parameters<AudioBufferSourceNode['start']>) => { (window as any).realAudio.starts++; start(...args); }; return node; };
      return ctx;
    };
  });
  await visit(page); await page.locator('.face').first().click();
  await expect.poll(() => page.evaluate(() => ({ starts: (window as any).realAudio.starts, state: (window as any).realAudio.ctx.state }))).toEqual({ starts: 1, state: 'running' });
  await page.locator('#stop').click(); expect(await page.locator('.pad.playing').count()).toBe(0);
  await page.close();
});

it('keeps Stop effective while the native context resume promise is pending', async () => {
  const page = await offlinePage(1, true), before = readEvents(p, id).filter(e => e.type === 'play').length;
  let assets = 0; page.on('request', r => { if (r.url().includes('/assets/')) assets++; });
  await visit(page); await page.locator('.face').first().click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).nativeAudio.resume)).toBe('function');
  await page.locator('#stop').click();
  await page.evaluate(async () => { (window as any).nativeAudio.resume(); await Promise.resolve(); });
  expect(await page.evaluate(() => (window as any).nativeAudio.starts.length)).toBe(0);
  expect(assets).toBe(0);
  expect(await page.locator('.pad.playing, #toast.show').count()).toBe(0);
  expect(readEvents(p, id).filter(e => e.type === 'play')).toHaveLength(before);
  await page.close();
});

it('shows genuine asset errors without playing or recording a play, and can retry', async () => {
  const page = await offlinePage(), before = readEvents(p, id).filter(e => e.type === 'play').length, errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message)); await visit(page);
  const bad = Buffer.from(source.wav); bad[44] ^= 1; writeFileSync(source.path, bad);
  try {
    await page.locator('.face').first().click();
    await expect.poll(() => page.locator('#toast.show').textContent()).toContain('Could not play: sample fetch failed');
    expect(await page.evaluate(() => (window as any).nativeAudio.starts.length)).toBe(0);
    expect(await page.locator('.pad.playing').count()).toBe(0);
    expect(readEvents(p, id).filter(e => e.type === 'play')).toHaveLength(before);
  } finally { writeFileSync(source.path, source.wav); }
  await page.locator('.face').first().click();
  await expect.poll(() => page.evaluate(() => (window as any).nativeAudio.starts.length)).toBe(1);
  expect(errors).toEqual([]); await page.close();
});

it('uses actual measured sample onset for lint while preserving prepared PCM fades', async () => {
  const pch = setCandidatePatch(p, set.id, set.candidates[0].name), f = set.candidates[0].features as unknown as Features;
  expect(f.attackSec).toBeGreaterThanOrEqual(.002);
  expect(lintPatch(pch, f, p.project).errors.filter(e => e.rule === 'attack-floor')).toEqual([]);
  const abrupt = writeSampleObject(samplePaths(p).objects, writeWav([new Float32Array(7680).fill(.1)], 48000, { bits: 32 }));
  pch.layers[0].source = { type: 'sample', asset: abrupt.id };
  const host = await openRenderHost();
  try {
    const [r] = await host.render([{ patch: pch, opts: { sampleWavs: { [abrupt.id]: abrupt.wav.toString('base64') } } }]);
    if (!r.ok) throw new Error(r.error);
    const measured = measure(r); expect(measured.attackSec).toBeLessThan(.002);
    expect(lintPatch(pch, measured, p.project).errors.filter(e => e.rule === 'attack-floor')).toEqual([expect.objectContaining({ message: expect.stringContaining('measured attack') })]);
  } finally { await host.close(); }
}, 30000);

