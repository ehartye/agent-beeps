// Delivery-format audition: encode planning, blind letters, byte totals, results folding, taste isolation and the server's data endpoints.
// Encoders are faked (they copy the WAV) so these run in milliseconds; the one real-ffmpeg test skips when ffmpeg is unavailable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, type OpenProject } from '../../src/project.ts';
import { writeWav } from '../../src/audio/wav.ts';
import { findFfmpeg } from '../../src/compress.ts';
import { AuditionServer, type ServerInfo } from '../../src/audition/server.ts';
import {
  appendDeliveryEvent, blindLetters, byteTotals, createDelivery, foldResults, planEncodes, presetArgs, preferencesFromResults, importPreferences,
  readDelivery, readDeliveryEvents, readDeliveryPrefs, deliveryPrefsFile, globalDeliveryPrefsFile, resolvePresets, sourceFromFile, sourcesFromDir, summarizePreferences,
  writeResults, deliveryDir, type Encoder, type Source,
} from '../../src/audition/delivery.ts';

const SR = 48000;
const hasFfmpeg = (() => { try { findFfmpeg(); return true; } catch { return false; } })();
const tone = (sec: number, hz = 440) => writeWav([Float32Array.from({ length: Math.round(SR * sec) }, (_, i) => 0.3 * Math.sin(2 * Math.PI * hz * i / SR))], SR);

/** Pretends to encode: the output is the WAV, padded so every preset has a distinct, plausible size (low bitrates are smaller). */
const fakeEncoder: Encoder = (_f, wav, out, p) => {
  const src = readFileSync(wav);
  const size = Math.max(100, Math.round(src.length * ((p.kbps ?? (p.vbrQuality === undefined ? 1000 : 130 - p.vbrQuality * 10)) / 1536)));
  writeFileSync(out, src.subarray(0, Math.min(size, src.length)));
};

let home: string, p: OpenProject, wavs: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'beeps-dhome-'));
  process.env.AGENT_BEEPS_HOME = home;
  p = initProject(mkdtempSync(join(tmpdir(), 'beeps-delivery-')));
  wavs = mkdtempSync(join(tmpdir(), 'beeps-dwav-'));
  writeFileSync(join(wavs, 'coin.wav'), tone(0.5, 880));
  writeFileSync(join(wavs, 'theme.wav'), tone(30, 220));
});

const sources = (): Source[] => [sourceFromFile(join(wavs, 'coin.wav')), sourceFromFile(join(wavs, 'theme.wav'))];

describe('presets and planning', () => {
  it('always includes the hidden reference and refuses unknown or codec-less lists', () => {
    expect(resolvePresets(undefined).map(x => x.id)).toEqual(['wav', 'mp3-64', 'mp3-96', 'mp3-v5', 'opus-32', 'opus-48', 'opus-64', 'anchor']);
    expect(resolvePresets(['mp3-96', 'opus-48']).map(x => x.id)).toEqual(['wav', 'mp3-96', 'opus-48']);
    expect(resolvePresets(undefined, { anchor: false }).some(x => x.kind === 'anchor')).toBe(false);
    expect(() => resolvePresets(['mp3-7'])).toThrow(/unknown preset/);
    expect(() => resolvePresets(['wav', 'anchor'])).toThrow(/at least one/);
  });

  it('encodes through the compress arguments, so what is heard is what ships', () => {
    const by = Object.fromEntries(resolvePresets(['mp3-64', 'mp3-v2', 'opus-64', 'anchor']).map(x => [x.id, x]));
    expect(presetArgs(by['mp3-64'])).toEqual(expect.arrayContaining(['libmp3lame', '64k']));
    expect(presetArgs(by['opus-64'])).toEqual(expect.arrayContaining(['libopus', '64k']));
    expect(presetArgs(by['mp3-v2'])).toEqual(expect.arrayContaining(['-q:a', '2']));
    expect(presetArgs(by.anchor).join(' ')).toContain('lowpass=f=3500');
    expect(presetArgs(by.wav)).toEqual([]);
  });

  it('plans one file per item and preset, named without leaking letters', () => {
    const jobs = planEncodes(sources(), resolvePresets(['mp3-96', 'opus-48']));
    expect(jobs).toHaveLength(6);
    expect(jobs[0]).toEqual({ item: 'i1', preset: 'wav', file: 'i1-coin.wav.wav' });
    expect(jobs.at(-1)).toEqual({ item: 'i2', preset: 'opus-48', file: 'i2-theme.opus-48.ogg' });
  });

  it('shuffles letters per seed, deterministically', () => {
    const a = blindLetters(8, 7), b = blindLetters(8, 7), c = blindLetters(8, 8);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(a).not.toEqual(c);
  });

  it('finds bundle sidecars, roles and loops, or guesses the role from length', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-dbundle-'));
    copyFileSync(join(wavs, 'theme.wav'), join(dir, 'theme.wav'));
    writeFileSync(join(dir, 'theme.wav.json'), JSON.stringify({ schema: 'beeps/audio-asset@1', id: 'mus-theme', label: 'Theme', description: '', role: 'ambience', file: 'theme.wav', loop: true, durationSec: 30, sampleRate: SR, channels: 1, renderKey: 'k', loudness: { metric: 'integrated', lufs: -20 }, truePeakDb: -3, normalizationAlreadyApplied: true }));
    expect(sourcesFromDir(dir)).toMatchObject([{ name: 'mus-theme', role: 'ambience', loop: true }]);
    expect(sourceFromFile(join(wavs, 'theme.wav'))).toMatchObject({ role: 'music', loop: false });
    expect(sourceFromFile(join(wavs, 'coin.wav'))).toMatchObject({ role: 'sfx' });
    expect(() => sourceFromFile(join(dir, 'x.mp3'))).toThrow(/does not exist/);
  });
});

describe('createDelivery', () => {
  it('writes scratch encodes under the project, never next to the masters, and ignores them in git', () => {
    const d = createDelivery(p, sources(), resolvePresets(undefined), { encoder: fakeEncoder, seed: 1 });
    expect(d.items).toHaveLength(2);
    expect(d.items[0].tracks.map(t => t.letter).sort().join('')).toBe('ABCDEFGH');
    expect(existsSync(join(deliveryDir(p, d.id), 'enc', 'i1-coin.mp3-64.mp3'))).toBe(true);
    expect(readFileSync(join(p.paths.dir, '.gitignore'), 'utf8')).toMatch(/^delivery\/$/m);
    expect(readDelivery(p, d.id).id).toBe(d.id);
    // masters untouched
    expect(readFileSync(join(wavs, 'coin.wav')).equals(tone(0.5, 880))).toBe(true);
  });

  it('projects catalog bytes per preset from the real encoded sizes', () => {
    const d = createDelivery(p, sources(), resolvePresets(['mp3-64', 'mp3-96', 'opus-48']), { encoder: fakeEncoder, catalog: { music: 600, sfx: 60 } });
    const totals = byteTotals(d);
    const get = (id: string) => totals.find(t => t.preset === id)!;
    const sum = (id: string) => d.items.reduce((s, it) => s + it.tracks.find(t => t.preset === id)!.bytes, 0);
    expect(get('mp3-96').bytes).toBe(sum('mp3-96'));
    expect(get('mp3-96').bytes).toBeGreaterThan(get('mp3-64').bytes);
    expect(get('wav').byRole.music.seconds).toBe(30);
    const per = (id: string, role: string) => get(id).byRole[role].bytesPerSec;
    expect(get('mp3-64').projectedBytes).toBe(Math.round(600 * per('mp3-64', 'music') + 60 * per('mp3-64', 'sfx')));
    expect(get('wav').projectedBytes!).toBeGreaterThan(get('mp3-96').projectedBytes!);
    expect(byteTotals(createDelivery(p, sources(), resolvePresets(['mp3-64']), { encoder: fakeEncoder }))[0].projectedBytes).toBeUndefined();
  });

  it.skipIf(!hasFfmpeg)('encodes real MP3, VBR, Opus and the low-pass anchor with ffmpeg', () => {
    const d = createDelivery(p, [sourceFromFile(join(wavs, 'coin.wav'))], resolvePresets(['mp3-64', 'mp3-v5', 'opus-32', 'anchor']));
    const bytes = Object.fromEntries(d.items[0].tracks.map(t => [t.preset, t.bytes]));
    expect(bytes['mp3-64']).toBeGreaterThan(500);
    expect(bytes['opus-32']).toBeLessThan(bytes.wav);
    expect(bytes['mp3-v5']).toBeGreaterThan(500);
    expect(bytes.anchor).toBeGreaterThan(1000);
    expect(d.encoder?.ffmpeg).toBeTruthy();
    // the file the owner hears for an MP3 letter really is an MP3 (frame sync or an ID3/Xing header)
    const mp3 = readFileSync(join(deliveryDir(p, d.id), 'enc', d.items[0].tracks.find(t => t.preset === 'mp3-64')!.file));
    expect(mp3.includes(Buffer.from('Info')) || mp3.includes(Buffer.from('Xing'))).toBe(true);
  });
});

describe('ratings, reveal and results', () => {
  const rateAll = (id: string, d: ReturnType<typeof readDelivery>, score: Record<string, number>, worse: string[] = []) => {
    for (const it of d.items) for (const t of it.tracks) appendDeliveryEvent(p, id, { type: 'rate', item: it.id, letter: t.letter, rating: score[t.preset], worse: worse.includes(t.preset), note: '' });
  };

  it('rejects bad events and unknown letters', () => {
    const d = createDelivery(p, sources(), resolvePresets(['mp3-64']), { encoder: fakeEncoder });
    expect(() => appendDeliveryEvent(p, d.id, { type: 'rate', item: 'i1', letter: 'Z', rating: 3 })).toThrow(/no i1\/Z/);
    expect(() => appendDeliveryEvent(p, d.id, { type: 'rate', item: 'i1', letter: 'A', rating: 9 })).toThrow(/bad delivery event/);
    expect(() => appendDeliveryEvent(p, d.id, { type: 'ship' })).toThrow(/bad delivery event/);
  });

  it('folds the last rating per letter, screens the listener with the anchor, and names the smallest acceptable preset per role', () => {
    const d = createDelivery(p, sources(), resolvePresets(['mp3-64', 'mp3-96', 'opus-48', 'anchor']), { encoder: fakeEncoder, seed: 3 });
    rateAll(d.id, d, { wav: 5, anchor: 2, 'mp3-64': 3, 'mp3-96': 5, 'opus-48': 5 }, ['mp3-64']);
    appendDeliveryEvent(p, d.id, { type: 'device', report: { userAgent: 'test', decode: { mp3: { ok: true } } } });
    appendDeliveryEvent(p, d.id, { type: 'note', text: 'mp3 64 is mushy on the theme' });
    const before = foldResults(d, readDeliveryEvents(p, d.id));
    expect(before.revealed).toBe(false);
    expect(before.prediction).toBe('not-applicable');
    appendDeliveryEvent(p, d.id, { type: 'reveal' });
    const r = writeResults(p, d.id);
    expect(r.revealed).toBe(true);
    expect(r.notes).toEqual(['mp3 64 is mushy on the theme']);
    expect(r.device).toMatchObject({ userAgent: 'test' });
    const music = r.summary.music, sfx = r.summary.sfx;
    expect(music.referenceMean).toBe(5);
    expect(music.anchorMean).toBe(2);
    expect(music.screening).toEqual({ pairs: 1, passed: 1, reliable: true });
    expect(music.presets.find(x => x.preset === 'mp3-64')).toMatchObject({ meanRating: 3, worse: 1, acceptable: false });
    expect(music.presets.find(x => x.preset === 'opus-48')).toMatchObject({ acceptable: true });
    // opus-48 is smaller per second than mp3-96 in the fake sizes, so it is the suggestion
    expect(music.suggest).toBe('opus-48');
    expect(sfx.suggest).not.toBeNull();
    expect(JSON.parse(readFileSync(join(deliveryDir(p, d.id), 'results.json'), 'utf8')).schema).toBe('beeps/delivery-results@1');
  });

  it('flags a listener who rated the anchor as good as the original', () => {
    const d = createDelivery(p, sources(), resolvePresets(['mp3-96', 'anchor']), { encoder: fakeEncoder });
    rateAll(d.id, d, { wav: 4, anchor: 5, 'mp3-96': 4 });
    expect(foldResults(d, readDeliveryEvents(p, d.id)).summary.music.screening).toEqual({ pairs: 1, passed: 0, reliable: false });
  });
});

describe('taste: delivery preferences stay apart from the verdicts the model fits', () => {
  it('imports once per session into delivery.jsonl and leaves verdicts.jsonl and the model alone', () => {
    const d = createDelivery(p, sources(), resolvePresets(['mp3-64', 'opus-48']), { encoder: fakeEncoder });
    for (const it of d.items) for (const t of it.tracks) appendDeliveryEvent(p, d.id, { type: 'rate', item: it.id, letter: t.letter, rating: t.preset === 'wav' ? 5 : t.preset === 'mp3-64' ? 2 : 5, worse: t.preset === 'mp3-64' });
    const r = writeResults(p, d.id);
    const rows = preferencesFromResults(r, d);
    expect(rows.map(x => `${x.role}/${x.preset}`).sort()).toEqual(['music/mp3-64', 'music/opus-48', 'sfx/mp3-64', 'sfx/opus-48']);
    const verdicts = join(p.paths.taste, 'verdicts.jsonl');
    expect(importPreferences(p, rows)).toBe(true);
    expect(importPreferences(p, rows)).toBe(false);
    expect(readDeliveryPrefs(deliveryPrefsFile(p))).toHaveLength(4);
    expect(readDeliveryPrefs(globalDeliveryPrefsFile())).toHaveLength(4);
    expect(existsSync(verdicts)).toBe(false);
    const sum = summarizePreferences(readDeliveryPrefs(deliveryPrefsFile(p)));
    expect(sum.find(x => x.role === 'music' && x.preset === 'opus-48')).toMatchObject({ vsReference: 0, acceptable: '1/1' });
    expect(sum.find(x => x.role === 'music' && x.preset === 'mp3-64')).toMatchObject({ vsReference: -3, worseFlags: 1 });
  });

  it('beeps taste import reads results.json and beeps taste show lists the preferences', () => {
    const d = createDelivery(p, sources(), resolvePresets(['mp3-96', 'anchor']), { encoder: fakeEncoder });
    for (const it of d.items) for (const t of it.tracks) appendDeliveryEvent(p, d.id, { type: 'rate', item: it.id, letter: t.letter, rating: t.preset === 'anchor' ? 1 : 5 });
    writeResults(p, d.id);
    const bin = join(import.meta.dirname, '..', '..', 'scripts', 'beeps.mjs');
    const run = (...args: string[]) => { const r = spawnSync(process.execPath, [bin, '--project', p.paths.root, ...args], { encoding: 'utf8', env: { ...process.env, AGENT_BEEPS_HOME: home } }); return { status: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop() || 'null'), stderr: r.stderr }; };
    const file = join(deliveryDir(p, d.id), 'results.json');
    const dry = run('taste', 'import', file, '--dry-run');
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.out).toMatchObject({ imported: false, kind: 'delivery', preferences: 2 });
    const first = run('taste', 'import', file);
    expect(first.out).toMatchObject({ imported: true, roles: expect.arrayContaining(['music', 'sfx']) });
    expect(run('taste', 'import', file).out).toMatchObject({ imported: false, alreadyImported: true });
    const show = run('taste', 'show');
    expect(show.out.delivery.some((x: { preset: string }) => x.preset === 'mp3-96')).toBe(true);
    expect(show.out.verdicts).toMatchObject({ global: 0, project: 0, malformed: 0 });
  });
});

describe('server data endpoints', () => {
  let server: AuditionServer, info: ServerInfo, id: string;
  beforeAll(async () => {
    const d = createDelivery(p, sources(), resolvePresets(['mp3-64', 'opus-48', 'anchor']), { encoder: fakeEncoder, catalog: { music: 300 }, title: 'Fixture formats' });
    id = d.id;
    server = new AuditionServer({ host: '127.0.0.1', port: 0, token: 'tok', projects: [p.paths.root] });
    info = await server.listen();
  });
  afterAll(async () => { await server?.close(); });
  const api = (path: string, init: RequestInit = {}, token = 'tok') => fetch(`http://127.0.0.1:${info.port}${path}${path.includes('?') ? '&' : '?'}t=${token}`, init);
  const post = (body: unknown) => api(`/api/delivery/${id}/event`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  it('needs the token, serves the page, and keeps presets out of the page data', async () => {
    expect((await api(`/api/delivery/${id}`, {}, 'bad')).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${info.port}/d/${id}`)).status).toBe(200);
    const page = await (await api(`/api/delivery/${id}`)).json();
    expect(page.title).toBe('Fixture formats');
    expect(page.items).toHaveLength(2);
    expect(page.items[0].tracks).toHaveLength(4);
    const text = JSON.stringify(page);
    expect(text).not.toMatch(/mp3-64|opus-48|"preset"|anchor|bytes/);
    expect(page.revealed).toBe(false);
  });

  it('streams each letter with byte ranges and its own content type, and refuses anything it does not list', async () => {
    const page = await (await api(`/api/delivery/${id}`)).json();
    const tracks = page.items[0].tracks as { letter: string; family: string; url: string }[];
    const mp3 = tracks.find(t => t.family === 'mp3')!, opus = tracks.find(t => t.family === 'opus')!;
    const full = await api(mp3.url);
    expect(full.headers.get('content-type')).toBe('audio/mpeg');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    const whole = Buffer.from(await full.arrayBuffer());
    const part = await api(mp3.url, { headers: { range: 'bytes=0-9' } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(whole.subarray(0, 10))).toBe(true);
    expect((await api(opus.url)).headers.get('content-type')).toBe('audio/ogg');
    expect((await api(`/api/delivery/${id}/audio/i1/Z`)).status).toBe(404);
    expect((await api(`/api/delivery/${id}/audio/i9/A`)).status).toBe(404);
    expect((await api(`/api/delivery/nope/audio/i1/A`)).status).toBe(404);
  });

  it('keeps the key sealed until reveal, records ratings and device reports, then reveals with byte totals', async () => {
    expect((await api(`/api/delivery/${id}/reveal`)).status).toBe(404);
    expect((await api(`/api/delivery/${id}/results`)).status).toBe(404);
    expect((await post({ type: 'rate', item: 'i1', letter: 'A', rating: 0 })).status).toBe(400);
    expect((await post({ type: 'ship' })).status).toBe(400);
    expect((await post({ type: 'device', report: { userAgent: 'phone', canPlayType: { opus: '' } } })).status).toBe(200);
    expect((await post({ type: 'rate', item: 'i1', letter: 'B', rating: 4, worse: true, note: 'fizzy' })).status).toBe(200);
    const again = await (await api(`/api/delivery/${id}`)).json();
    expect(again.ratings).toEqual([{ item: 'i1', letter: 'B', rating: 4, worse: true, note: 'fizzy' }]);
    expect((await post({ type: 'reveal' })).status).toBe(200);
    const rev = await (await api(`/api/delivery/${id}/reveal`)).json();
    expect(rev.key).toHaveLength(8);
    expect(new Set(rev.key.filter((k: { item: string }) => k.item === 'i1').map((k: { preset: string }) => k.preset))).toEqual(new Set(['wav', 'mp3-64', 'opus-48', 'anchor']));
    const mp3 = rev.totals.find((t: { preset: string }) => t.preset === 'mp3-64');
    expect(mp3.projectedBytes).toBeGreaterThan(0);
    expect((await (await api(`/api/delivery/${id}/results`)).json()).device).toMatchObject({ userAgent: 'phone' });
  });
});
