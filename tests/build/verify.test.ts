// `beeps verify` and the static container checks: no decoding, just what the headers say.
import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../../src/audio/wav.ts';
import { encodeMp3, encodeOpus, findFfmpeg } from '../../src/compress.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { runBuild } from '../../src/build/build.ts';
import { staticCheck, verifyOutputs } from '../../src/build/verify.ts';
import { cloneFixture, makeFixture, type Fixture } from '../helpers/build-fixture.ts';

const ffmpeg = (() => { try { return findFfmpeg(); } catch { return undefined; } })();
const hasChromium = await chromiumAvailable();

describe.skipIf(!ffmpeg)('static container checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-static-'));
  const FRAMES = 48000 * 2 + 123; // an odd length: a codec that rounds to a frame boundary shows
  const wav = join(dir, 'tone.wav');
  const tone = (ch: number) => Float32Array.from({ length: FRAMES }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000 + ch));
  writeFileSync(wav, writeWav([tone(0), tone(1)], 48000));

  it('reads Ogg Opus: header, end of stream, and the exact length from the last granule position', () => {
    const f = join(dir, 'a.ogg');
    encodeOpus(ffmpeg!, wav, f, 44);
    const r = staticCheck(f, { frames: FRAMES, channels: 2, loop: true });
    expect(r.problems).toEqual([]);
    expect(r.info).toMatchObject({ format: 'opus', frames: FRAMES, channels: 2 });
    expect(staticCheck(f, { frames: FRAMES + 1 }).problems[0]).toMatch(/granule position implies/);
    expect(staticCheck(f, { channels: 1 }).problems[0]).toMatch(/2 channels, sidecar says 1/);
  });

  it('flags a truncated Opus file and a file that is not Opus', () => {
    const f = join(dir, 'cut.ogg');
    writeFileSync(f, readFileSync(join(dir, 'a.ogg')));
    truncateSync(f, readFileSync(f).length - 40);
    expect(staticCheck(f).problems.join()).toMatch(/truncated|end-of-stream|bad Ogg/);
    const junk = join(dir, 'junk.ogg');
    writeFileSync(junk, Buffer.from('OggS' + 'x'.repeat(60)));
    expect(staticCheck(junk).problems.length).toBeGreaterThan(0);
  });

  it('reads the MP3 Xing/Info tag and its LAME delay and padding', () => {
    const f = join(dir, 'a.mp3');
    encodeMp3(ffmpeg!, wav, f, 80);
    const r = staticCheck(f, { frames: FRAMES, channels: 2, loop: true });
    expect(r.problems).toEqual([]);
    expect(r.info).toMatchObject({ format: 'mp3', channels: 2, delay: 576 });
    expect(r.info.encoder).not.toMatch(/^Lavf/);
    expect(Math.abs(r.info.frames! - FRAMES)).toBeLessThanOrEqual(1);
  });

  it('flags an MP3 written with -fflags +bitexact (encoder id "Lavf lame": Firefox then ignores the delay)', () => {
    const f = join(dir, 'bitexact.mp3');
    const r = spawnSync(ffmpeg!, ['-y', '-hide_banner', '-loglevel', 'error', '-i', wav, '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '80k', '-write_xing', '1', '-id3v2_version', '0', '-fflags', '+bitexact', '-flags:a', '+bitexact', f]);
    expect(r.status).toBe(0);
    const c = staticCheck(f, { frames: FRAMES, loop: true });
    expect(c.info.encoder).toMatch(/^Lavf/);
    expect(c.problems.join()).toMatch(/Lavf.*bitexact/);
  });

  it('flags an MP3 with no Xing/Info tag (WebKit on Linux cannot trim its padding)', () => {
    const f = join(dir, 'notag.mp3');
    const r = spawnSync(ffmpeg!, ['-y', '-hide_banner', '-loglevel', 'error', '-i', wav, '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '80k', '-write_xing', '0', '-id3v2_version', '0', f]);
    expect(r.status).toBe(0);
    expect(staticCheck(f, { frames: FRAMES }).problems[0]).toMatch(/no Xing\/Info tag/);
  });

  it('reads WAV lengths', () => {
    expect(staticCheck(wav, { frames: FRAMES, channels: 2 })).toMatchObject({ problems: [], info: { format: 'wav', frames: FRAMES } });
    expect(staticCheck(wav, { frames: FRAMES - 1 }).problems[0]).toMatch(/WAV has/);
  });
});

describe.skipIf(!ffmpeg || !hasChromium)('beeps verify', () => {
  let base: Fixture;
  beforeAll(async () => { base = makeFixture(); await runBuild(base.cfg()); }, 180000);
  const verify = (fx: Fixture, o: { decode?: boolean; catalog?: boolean } = {}) => verifyOutputs({ lock: fx.path('audio.lock.json'), out: fx.path('public/audio'), ...o });

  it('passes on a fresh build, including the decode checks', () => {
    const r = verify(base, { decode: true });
    expect(r).toMatchObject({ ok: true, problems: [], assets: 4 });
    expect(r.warnings).toEqual([]);
  });

  it('reports a modified file, a missing file and a wrong size, naming the asset', () => {
    const fx = cloneFixture(base);
    writeFileSync(fx.path('public/audio/coin.0.ogg'), 'tampered');
    rmSync(fx.path('public/audio/blip.0.ogg'));
    const f = fx.path('public/audio/plain.ogg');
    writeFileSync(f, Buffer.concat([readFileSync(f), Buffer.from('x')]));
    const r = verify(fx);
    expect(r.ok).toBe(false);
    const by = Object.fromEntries(r.problems.filter(p => p.asset).map(p => [`${p.asset}:${p.file}`, p.problem]));
    expect(by['coin:coin.0.ogg']).toMatch(/bytes, lock says|sha256/);
    expect(by['blip:blip.0.ogg']).toBe('missing');
    expect(by['plain:plain.ogg']).toMatch(/bytes, lock says/);
  });

  it('catches a file that matches the lock but is not a valid Opus file for its sidecar', () => {
    const fx = cloneFixture(base);
    // Replace a layer with another asset's Opus and re-sign it in the lock: the hash is right, the headers say the wrong length.
    const lock = fx.read('audio.lock.json');
    const other = readFileSync(fx.path('public/audio/coin.0.ogg')); // 0.3 s, not the 2 s the sidecar promises
    writeFileSync(fx.path('public/audio/theme.bed.ogg'), other);
    const entry = lock.assets.theme.outputs.find((o: any) => o.file === 'theme.bed.ogg');
    entry.bytes = other.length;
    entry.sha256 = createHash('sha256').update(other).digest('hex');
    fx.write('audio.lock.json', lock);
    const r = verify(fx);
    expect(r.problems.map(p => p.problem).join()).toMatch(/granule position implies/);
  });

  it('checks the catalog and warns about files the lock does not own', () => {
    const fx = cloneFixture(base);
    writeFileSync(fx.path('public/audio/stray.ogg'), 'x');
    const idx = fx.read('public/audio/index.json');
    delete idx.assets.coin;
    idx.assets.theme.layers[0].file = 'gone.ogg';
    fx.write('public/audio/index.json', idx);
    const r = verify(fx);
    expect(r.warnings.join()).toMatch(/stray\.ogg is not in the lock/);
    expect(r.problems.map(p => p.problem)).toEqual(expect.arrayContaining(['in the lock but not in index.json', 'listed in index.json but missing']));
    rmSync(fx.path('public/audio/index.json'));
    expect(verify(fx).problems.some(p => p.file === 'index.json')).toBe(true);
    expect(verify(fx, { catalog: false }).problems.some(p => p.file === 'index.json')).toBe(false);
  });
});
