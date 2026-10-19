import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSampleWav } from '../../runtime/engine/sample-wav.js';
import { writeWav, readWav } from '../../src/audio/wav.ts';
import { decodeAudio } from '../../src/audio/decode.ts';
import { patchSampleIds, readSampleObject, resolvePatchSamples, sampleId, samplePaths, verifyImmutableFile, writeSampleObject } from '../../src/samples/store.ts';
import { findFfmpeg } from '../../src/compress.ts';

// Real filesystem operations with fault injection only at the write/publication boundaries.
const fsFault = vi.hoisted(() => ({ failNextWrite: false, failPublishCode: undefined as string | undefined, beforePublish: undefined as ((staged: string, destination: string) => void) | undefined }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsFault.failNextWrite) {
        fsFault.failNextWrite = false;
        actual.writeFileSync(args[0], (args[1] as Uint8Array).subarray(0, 8), args[2]);
        throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
      }
      return actual.writeFileSync(...args);
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (fsFault.failPublishCode) {
        const code = fsFault.failPublishCode; fsFault.failPublishCode = undefined;
        throw Object.assign(new Error('injected unsupported hard link'), { code });
      }
      const beforePublish = fsFault.beforePublish; fsFault.beforePublish = undefined;
      beforePublish?.(String(args[0]), String(args[1]));
      return actual.linkSync(...args);
    },
  };
});

const ffmpeg = (() => { try { return findFfmpeg(); } catch { return undefined; } })();

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'beeps-samples-')); dirs.push(d); return d; };
afterEach(() => {
  fsFault.failNextWrite = false; fsFault.failPublishCode = undefined; fsFault.beforePublish = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const wav = (channels = [new Float32Array([0, .25, -.5])]) => writeWav(channels, 48000, { bits: 32 });

describe('canonical sample WAV', () => {
  it('retains mono and stereo finite float PCM from typed bytes or ArrayBuffer', () => {
    for (const channels of [[new Float32Array([0, 2, -.5])], [new Float32Array([.1, .2]), new Float32Array([-.3, -.4])]]) {
      const b = wav(channels);
      const padded = Buffer.concat([Buffer.alloc(3), b, Buffer.alloc(2)]);
      for (const bytes of [padded.subarray(3, 3 + b.length), Uint8Array.from(b).buffer]) {
        const got = readSampleWav(bytes);
        expect(got.sampleRate).toBe(48000);
        expect(got.frames).toBe(channels[0].length);
        expect(got.channels).toEqual(channels);
      }
    }
  });
  it('rejects every noncanonical header field, truncated/trailing bytes and nonfinite PCM', () => {
    const mutations = [
      (b: Buffer) => b.write('RIFX', 0), (b: Buffer) => b.writeUInt32LE(1, 4),
      (b: Buffer) => b.write('NOPE', 8), (b: Buffer) => b.write('junk', 12),
      (b: Buffer) => b.writeUInt32LE(18, 16), (b: Buffer) => b.writeUInt16LE(1, 20),
      (b: Buffer) => b.writeUInt16LE(3, 22), (b: Buffer) => b.writeUInt32LE(44100, 24),
      (b: Buffer) => b.writeUInt32LE(1, 28), (b: Buffer) => b.writeUInt16LE(1, 32),
      (b: Buffer) => b.writeUInt16LE(16, 34), (b: Buffer) => b.write('JUNK', 36),
      (b: Buffer) => b.writeUInt32LE(0xfffffff0, 40), (b: Buffer) => b.writeFloatLE(NaN, 44),
      (b: Buffer) => b.writeFloatLE(Infinity, 44),
    ];
    for (const mutate of mutations) { const b = wav(); mutate(b); expect(() => readSampleWav(b)).toThrow(); }
    for (const b of [Buffer.alloc(0), wav().subarray(0, 43), wav().subarray(0, -1), Buffer.concat([wav(), Buffer.alloc(1)]), wav([new Float32Array(0)])]) {
      expect(() => readSampleWav(b)).toThrow();
    }
  });
  it('checks frame bounds before PCM allocation, with an explicit retained-source allowance', () => {
    expect(() => readSampleWav(wav(), { maxFrames: 2 })).toThrow(/frames|bound|limit/i);
    const source = wav([new Float32Array(480001)]);
    expect(() => readSampleWav(source)).toThrow(/frames|bound|limit/i);
    expect(readSampleWav(source, { maxFrames: 5760000 }).frames).toBe(480001);
    for (const maxFrames of [0, Infinity, 1.5, 5760001]) expect(() => readSampleWav(wav(), { maxFrames })).toThrow();
  });
});

describe('verified sample objects', () => {
  it('derives store paths and deduplicates only sample layer references', () => {
    const paths = samplePaths({ paths: { dir: 'project-store' } });
    expect(paths.objects).toBe(join('project-store', 'samples', 'objects'));
    expect(samplePaths('project-root').objects).toBe(join('project-root', '.agent-beeps', 'samples', 'objects'));
    const a = sampleId(wav()), b = sampleId(wav([new Float32Array([1])]));
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(patchSampleIds({ layers: [{ source: { type: 'sample', asset: b } }, { source: { type: 'sample', asset: a } }, { source: { type: 'sample', asset: b } }, { source: { type: 'noise' } }] })).toEqual([a, b].sort());
    expect(resolvePatchSamples({ layers: [] }, join(dir(), 'does-not-exist'))).toEqual([]);
    expect(() => patchSampleIds({ layers: [{ source: { type: 'sample', asset: '../bad' } }] })).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
  });
  it('verifies actual bytes and derives metadata on every resolution', () => {
    const objects = dir(), bytes = wav([new Float32Array([.1, .2]), new Float32Array([.3, .4])]), id = sampleId(bytes);
    const path = join(objects, `${id.slice(7)}.wav`); writeFileSync(path, bytes);
    const patch = { layers: [{ source: { type: 'sample', asset: id } }] };
    expect(resolvePatchSamples(patch, objects)).toEqual([{ id, path, wav: bytes, sampleRate: 48000, channels: 2, frames: 2, bytes: bytes.length }]);
    const corrupt = Buffer.from(bytes); corrupt.writeFloatLE(.9, 44); writeFileSync(path, corrupt);
    expect(() => resolvePatchSamples(patch, objects)).toThrowError(expect.objectContaining({ code: 'E_VERIFY' }));
    rmSync(path);
    expect(() => readSampleObject(objects, id)).toThrowError(expect.objectContaining({ code: 'E_NOT_FOUND' }));
  });
  it('rejects hash-valid malformed objects and traversal IDs', () => {
    const objects = dir(), bytes = Buffer.from('not audio'), id = sampleId(bytes);
    writeFileSync(join(objects, `${id.slice(7)}.wav`), bytes);
    expect(() => readSampleObject(objects, id)).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
    expect(() => readSampleObject(objects, '../outside')).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
  });
  it('writes only canonical objects and verifies existing immutable content', () => {
    const objects = join(dir(), 'objects'), bytes = wav(), result = writeSampleObject(objects, bytes);
    expect(readFileSync(result.path)).toEqual(bytes);
    expect(writeSampleObject(objects, bytes)).toEqual(result);
    writeFileSync(result.path, 'corrupt');
    expect(() => writeSampleObject(objects, bytes)).toThrowError(expect.objectContaining({ code: 'E_VERIFY' }));
    expect(() => writeSampleObject(objects, Buffer.from('invalid'))).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
  });
  it('cleans up an interrupted write without publishing partial bytes, so an ordinary retry succeeds', () => {
    const objects = join(dir(), 'objects'), bytes = wav(), path = join(objects, `${sampleId(bytes).slice(7)}.wav`);
    fsFault.failNextWrite = true;
    expect(() => writeSampleObject(objects, bytes)).toThrowError(expect.objectContaining({ code: 'ENOSPC' }));
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(objects)).toEqual([]);
    expect(writeSampleObject(objects, bytes).path).toBe(path);
    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(objects)).toEqual([`${sampleId(bytes).slice(7)}.wav`]);
  });
  it('publishes complete bytes exclusively and verifies a legitimate writer winning the same destination', () => {
    const objects = join(dir(), 'objects'), bytes = wav(), path = join(objects, `${sampleId(bytes).slice(7)}.wav`);
    let observed = false;
    fsFault.beforePublish = (staged, destination) => {
      observed = true;
      expect(destination).toBe(path);
      expect(existsSync(path)).toBe(false);
      expect(readFileSync(staged)).toEqual(bytes);
      writeSampleObject(objects, bytes); // Another complete writer wins just before publication.
    };
    expect(writeSampleObject(objects, bytes).path).toBe(path);
    expect(observed).toBe(true);
    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(objects)).toEqual([`${sampleId(bytes).slice(7)}.wav`]);
  });
  it('preserves and rejects corruption that appears before exclusive publication', () => {
    const objects = join(dir(), 'objects'), bytes = wav(), path = join(objects, `${sampleId(bytes).slice(7)}.wav`);
    fsFault.beforePublish = (_staged, destination) => { writeFileSync(destination, 'concurrent corruption'); };
    expect(() => writeSampleObject(objects, bytes)).toThrowError(expect.objectContaining({ code: 'E_VERIFY' }));
    expect(readFileSync(path, 'utf8')).toBe('concurrent corruption');
    expect(readdirSync(objects)).toEqual([`${sampleId(bytes).slice(7)}.wav`]);
  });
  it('fails without exposing a destination when the filesystem cannot publish atomically', () => {
    const objects = join(dir(), 'objects'), bytes = wav();
    fsFault.failPublishCode = 'ENOTSUP';
    expect(() => writeSampleObject(objects, bytes)).toThrowError(expect.objectContaining({ code: 'E_STORE' }));
    expect(readdirSync(objects)).toEqual([]);
  });
  it('rejects a dangling link instead of treating the occupied immutable name as absent', () => {
    const objects = dir(), bytes = wav(), path = join(objects, `${sampleId(bytes).slice(7)}.wav`), target = join(objects, 'target');
    mkdirSync(target); symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir'); rmSync(target, { recursive: true });
    expect(existsSync(path)).toBe(false); expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(() => verifyImmutableFile(path, bytes)).toThrowError(expect.objectContaining({ code: 'E_VERIFY' }));
    expect(() => writeSampleObject(objects, bytes)).toThrowError(expect.objectContaining({ code: 'E_VERIFY' }));
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readdirSync(objects)).toEqual([`${sampleId(bytes).slice(7)}.wav`]);
  });
  it('requires an actual matching publication winner after EEXIST, including a dangling racing link', () => {
    const objects = dir(), bytes = wav(), path = join(objects, `${sampleId(bytes).slice(7)}.wav`);
    fsFault.failPublishCode = 'EEXIST';
    expect(() => writeSampleObject(objects, bytes)).toThrowError(expect.objectContaining({ code: 'E_VERIFY' }));
    expect(readdirSync(objects)).toEqual([]);
    fsFault.beforePublish = (_staged, destination) => {
      const target = join(objects, 'target'); mkdirSync(target); symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir'); rmSync(target, { recursive: true });
    };
    expect(() => writeSampleObject(objects, bytes)).toThrowError(expect.objectContaining({ code: 'E_VERIFY' }));
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readdirSync(objects)).toEqual([`${sampleId(bytes).slice(7)}.wav`]);
  });
});

describe('bounded native decode', () => {
  it('leaves supported native WAV decode independent of ffmpeg and optional limits', () => {
    const p = join(dir(), 'native.wav'); writeFileSync(p, wav());
    expect(decodeAudio(p, { identity: true })).toMatchObject({ sampleRate: 48000, sourceRate: 48000, decoder: { name: 'beeps-wav', version: 1 } });
  });
  it('rejects malicious RIFF data sizes before allocation', () => {
    const b = wav(); b.writeUInt32LE(0xfffffff0, 40);
    expect(() => readWav(b)).toThrowError(/truncat|chunk|data/i);
    const p = join(dir(), 'hostile.wav'); writeFileSync(p, b);
    expect(() => decodeAudio(p, { rate: 48000, maxSeconds: 120, maxChannels: 2 })).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
  });
  it('rejects frame, duration and channel bounds instead of truncating or downmixing', () => {
    const p = join(dir(), 'tiny.wav'); writeFileSync(p, wav());
    expect(() => decodeAudio(p, { maxFrames: 2 })).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
    expect(() => decodeAudio(p, { maxSeconds: 2 / 48000 })).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
    writeFileSync(p, wav(Array.from({ length: 3 }, () => new Float32Array([1]))));
    expect(() => decodeAudio(p, { maxChannels: 2 })).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
  });
  it('rejects invalid limits', () => {
    const p = join(dir(), 'tiny.wav'); writeFileSync(p, wav());
    for (const options of [{ maxSeconds: Infinity }, { maxFrames: -1 }, { maxChannels: 1.5 }, { maxInputBytes: NaN }, { rate: 0 }]) {
      expect(() => decodeAudio(p, options)).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
    }
  });
  it('rejects chunks outside the declared RIFF container', () => {
    const b = wav(); b.writeUInt32LE(4, 4);
    expect(() => readWav(b)).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
  });
  it.skipIf(!ffmpeg)('bounds compressed streams, preserves source rate, and records the ffmpeg build', () => {
    const d = dir(), input = join(d, 'input.wav'), compressed = join(d, 'input.flac');
    writeFileSync(input, writeWav([new Float32Array(4410)], 44100));
    expect(spawnSync(ffmpeg!, ['-v', 'error', '-y', '-i', input, compressed]).status).toBe(0);
    expect(() => decodeAudio(compressed, { rate: 48000, maxSeconds: .01, maxChannels: 2 })).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
    expect(() => decodeAudio(compressed, { maxFrames: 20 })).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
    const decoded = decodeAudio(compressed, { rate: 48000, maxSeconds: 1, maxChannels: 2, identity: true });
    expect(decoded).toMatchObject({ sampleRate: 48000, sourceRate: 44100, decoder: { name: 'ffmpeg', ffmpeg: expect.any(String), libavcodec: expect.any(String) } });
    expect(decoded.channels[0].length).toBe(4800);
    writeFileSync(input, writeWav(Array.from({ length: 3 }, () => new Float32Array(40)), 48000));
    expect(spawnSync(ffmpeg!, ['-v', 'error', '-y', '-i', input, compressed]).status).toBe(0);
    expect(() => decodeAudio(compressed, { rate: 48000, maxSeconds: 1, maxChannels: 2 })).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
  });
  it.skipIf(!ffmpeg)('decodes a valid compressed ADPCM WAV through ffmpeg rather than PCM header rules', () => {
    const d = dir(), input = join(d, 'input.wav'), compressed = join(d, 'input-adpcm.wav'), baseline = join(d, 'baseline.wav');
    writeFileSync(input, writeWav([Float32Array.from({ length: 4800 }, (_, i) => .2 * Math.sin(i / 20))], 48000));
    expect(spawnSync(ffmpeg!, ['-v', 'error', '-y', '-i', input, '-c:a', 'adpcm_ima_wav', compressed]).status).toBe(0);
    expect(spawnSync(ffmpeg!, ['-v', 'error', '-y', '-i', compressed, '-vn', '-c:a', 'pcm_f32le', baseline]).status).toBe(0);
    const expected = readWav(readFileSync(baseline));
    expect(decodeAudio(compressed).channels).toEqual(expected.channels);
    expect(decodeAudio(compressed, { rate: 48000, maxSeconds: 1, maxChannels: 2 }).channels).toEqual(expected.channels);
    expect(() => decodeAudio(compressed, { rate: 48000, maxSeconds: .01, maxChannels: 2 })).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
  });
  it.skipIf(!ffmpeg)('preserves ffmpeg automatic default-stream selection in metadata and PCM decoding', () => {
    const d = dir(), mono = join(d, 'mono.wav'), stereo = join(d, 'stereo.wav'), streams = join(d, 'streams.mka'), baseline = join(d, 'baseline.wav');
    writeFileSync(mono, writeWav([new Float32Array(960).fill(.25)], 48000));
    writeFileSync(stereo, writeWav([new Float32Array(960).fill(.1), new Float32Array(960).fill(-.1)], 48000));
    expect(spawnSync(ffmpeg!, ['-v', 'error', '-y', '-i', mono, '-i', stereo, '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_f32le', '-disposition:a:0', '0', '-disposition:a:1', 'default', streams]).status).toBe(0);
    expect(spawnSync(ffmpeg!, ['-v', 'error', '-y', '-i', streams, '-vn', '-c:a', 'pcm_f32le', baseline]).status).toBe(0);
    const expected = readWav(readFileSync(baseline));
    expect(expected.channels).toHaveLength(2);
    const legacy = decodeAudio(streams);
    expect(legacy.channels).toHaveLength(2);
    expect(legacy.channels).toEqual(expected.channels);
    expect(decodeAudio(streams, { rate: 48000, maxSeconds: 1, maxChannels: 2 }).channels).toEqual(expected.channels);
    expect(() => decodeAudio(streams, { rate: 48000, maxSeconds: 1, maxChannels: 1 })).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
  });
});
