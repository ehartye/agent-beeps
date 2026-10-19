import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../../src/audio/wav.ts';
import { readSampleWav } from '../../runtime/engine/sample-wav.js';
import { importSample, parseSamplePrep, prepareSample } from '../../src/samples/prepare.ts';
import { sampleId, samplePaths } from '../../src/samples/store.ts';
import { canonicalJson, sha256 } from '../../src/hash.ts';

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'beeps-prepare-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sourceFile = (d: string, channels = [new Float32Array([9, 1, 2, 3, 4, 5, 9])]) => { const p = join(d, 'input.wav'); writeFileSync(p, writeWav(channels, 48000, { bits: 32 })); return p; };
const recipe = (source: string, extra = {}) => ({ schema: 'beeps/sample-prep@1', source, startFrame: 1, endFrame: 6, fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0, ...extra });
const tree = (d: string): string[] => existsSync(d) ? readdirSync(d, { recursive: true }).map(String).sort() : [];

describe('sample import and provenance', () => {
  it('preserves exact original and independent normalized bytes with decoder identity', () => {
    const d = dir(), file = sourceFile(d), original = readFileSync(file);
    const r = importSample(d, file, { origin: 'field take A', license: 'CC0' });
    expect(readFileSync(r.originalPath)).toEqual(original);
    expect(readFileSync(r.objectPath)).toEqual(original);
    expect(r.originalId).toBe(sampleId(original));
    expect(r.normalizedId).toBe(sampleId(readFileSync(r.objectPath)));
    expect(r).toMatchObject({ sampleRate: 48000, channels: 1, frames: 7 });
    const receipt = JSON.parse(readFileSync(r.receiptPath, 'utf8'));
    expect(receipt).toMatchObject({ schema: 'beeps/sample-import@1', originalId: r.originalId, originalName: 'input.wav', normalizedId: r.normalizedId, origin: 'field take A', license: 'CC0', decoder: { name: 'beeps-wav', version: 1 } });
    expect(r.receiptId).toBe(`sha256:${sha256(canonicalJson(receipt))}`);
  });
  it('retains stereo and separate provenance receipts for identical normalized audio', () => {
    const d = dir(), file = sourceFile(d, [new Float32Array([.1, .2]), new Float32Array([.3, .4])]);
    const a = importSample(d, file, { origin: 'A' }), b = importSample(d, file, { origin: 'B' });
    expect(a.normalizedId).toBe(b.normalizedId);
    expect(a.receiptId).not.toBe(b.receiptId);
    expect(readdirSync(samplePaths(d).imports)).toHaveLength(2);
    expect(readSampleWav(readFileSync(a.objectPath)).channels).toEqual([new Float32Array([.1, .2]), new Float32Array([.3, .4])]);
  });
  it('normalizes 16-bit input without changing or confusing its original identity', () => {
    const d = dir(), file = join(d, 'pcm16.wav'), original = writeWav([new Float32Array([-.5, 0, .5])], 48000);
    writeFileSync(file, original);
    const r = importSample(d, file);
    expect(readFileSync(r.originalPath)).toEqual(original);
    expect(r.originalId).not.toBe(r.normalizedId);
    expect(readSampleWav(readFileSync(r.objectPath)).channels[0]).toEqual(new Float32Array([-.5, 0, 16384 / 32768]));
  });
  it('rejects invalid imports without creating store directories', () => {
    const d = dir(), file = sourceFile(d);
    for (const channels of [[new Float32Array(0)], [new Float32Array([NaN])], Array.from({ length: 3 }, () => new Float32Array([0]))]) {
      writeFileSync(file, writeWav(channels, 48000, { bits: 32 }));
      expect(() => importSample(d, file)).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
      expect(existsSync(samplePaths(d).dir)).toBe(false);
    }
    truncateSync(file, 64 * 1024 * 1024 + 1);
    expect(() => importSample(d, file)).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
    expect(existsSync(samplePaths(d).dir)).toBe(false);
    // 121 frames at 1 Hz is over the duration limit without a large fixture or ffmpeg.
    writeFileSync(file, writeWav([new Float32Array(121)], 1));
    expect(() => importSample(d, file)).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
    expect(existsSync(samplePaths(d).dir)).toBe(false);
  });
  it('never silently repairs corrupt existing objects or originals', () => {
    const d = dir(), file = sourceFile(d), a = importSample(d, file);
    writeFileSync(a.objectPath, Buffer.from('corrupt'));
    const before = tree(samplePaths(d).dir);
    expect(() => importSample(d, file, { origin: 'B' })).toThrowError(expect.objectContaining({ code: 'E_VERIFY' }));
    expect(readFileSync(a.objectPath, 'utf8')).toBe('corrupt');
    expect(tree(samplePaths(d).dir)).toEqual(before);
    copyFileSync(file, a.objectPath); writeFileSync(a.originalPath, Buffer.from('corrupt original'));
    expect(() => importSample(d, file)).toThrowError(expect.objectContaining({ code: 'E_VERIFY' }));
  });
});

describe('sample preparation', () => {
  it('crops end-exclusive, applies inclusive linear fades then gain, and hashes exact bytes', () => {
    const d = dir(), imported = importSample(d, sourceFile(d));
    const spec = recipe(imported.normalizedId, { fadeInFrames: 2, fadeOutFrames: 3, gainDb: 6 });
    const r = prepareSample(d, spec), output = readFileSync(r.objectPath), pcm = readSampleWav(output).channels[0];
    const g = 10 ** (6 / 20);
    expect(pcm).toEqual(new Float32Array([0, 2 * g, 3 * g, 2 * g, 0]));
    expect(r.recipeId).toBe(`sha256:${sha256(canonicalJson(spec))}`);
    expect(r.outputId).toBe(sampleId(output));
    expect(r).toMatchObject({ sampleRate: 48000, channels: 1, frames: 5, bytes: 64 });
    expect(JSON.parse(readFileSync(r.recipePath, 'utf8'))).toMatchObject({ recipe: spec, outputId: r.outputId });
    expect(r.receipt).toEqual(JSON.parse(readFileSync(r.recipePath, 'utf8')));
    expect(prepareSample(d, { ...spec })).toEqual(r);
  });
  it('has exact one-frame fades, neutral zero fades and channel-preserving crop', () => {
    const d = dir(), imported = importSample(d, sourceFile(d, [new Float32Array([9, 1, 2, 3, 4, 5, 9]), new Float32Array([8, -1, -2, -3, -4, -5, 8])]));
    const neutral = prepareSample(d, recipe(imported.normalizedId));
    expect(readSampleWav(readFileSync(neutral.objectPath)).channels).toEqual([new Float32Array([1, 2, 3, 4, 5]), new Float32Array([-1, -2, -3, -4, -5])]);
    const faded = prepareSample(d, recipe(imported.normalizedId, { fadeInFrames: 1, fadeOutFrames: 1 }));
    expect(readSampleWav(readFileSync(faded.objectPath)).channels).toEqual([new Float32Array([0, 2, 3, 4, 0]), new Float32Array([-0, -2, -3, -4, -0])]);
    const single = prepareSample(d, recipe(imported.normalizedId, { endFrame: 2, fadeInFrames: 1 }));
    expect(readSampleWav(readFileSync(single.objectPath)).channels[0]).toEqual(new Float32Array([0]));
  });
  it('rejects strict-schema, range, source-bound and overflowing recipes before any writes', () => {
    const d = dir(), imported = importSample(d, sourceFile(d));
    const before = tree(samplePaths(d).dir);
    for (const extra of [{ unknown: 1 }, { startFrame: -.1 }, { startFrame: 1.5 }, { endFrame: 1 }, { endFrame: 8 }, { endFrame: 480002 }, { fadeInFrames: -1 }, { fadeOutFrames: 1.5 }, { fadeInFrames: 3, fadeOutFrames: 3 }, { gainDb: 25 }, { gainDb: Infinity }, { source: 'file.wav' }]) {
      expect(() => prepareSample(d, recipe(imported.normalizedId, extra))).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
      expect(tree(samplePaths(d).dir)).toEqual(before);
    }
    const missing = recipe(imported.normalizedId) as Record<string, unknown>; delete missing.gainDb;
    expect(() => parseSamplePrep(missing)).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
    const loud = importSample(d, sourceFile(d, [new Float32Array([3.4e38])]));
    const beforeOverflow = tree(samplePaths(d).dir);
    expect(() => prepareSample(d, recipe(loud.normalizedId, { startFrame: 0, endFrame: 1, gainDb: 24 }))).toThrowError(expect.objectContaining({ code: 'E_SCHEMA' }));
    expect(tree(samplePaths(d).dir)).toEqual(beforeOverflow);
  });
  it('replays byte-exactly after deleting the original and relocating the store', () => {
    const d = dir(), file = sourceFile(d), imported = importSample(d, file), spec = recipe(imported.normalizedId);
    const first = prepareSample(d, spec), want = readFileSync(first.objectPath);
    rmSync(file); rmSync(imported.originalPath);
    const moved = dir(); cpSync(samplePaths(d).dir, samplePaths(moved).dir, { recursive: true });
    const replay = prepareSample(moved, spec);
    expect(replay.outputId).toBe(first.outputId);
    expect(readFileSync(replay.objectPath)).toEqual(want);
  });
  it('refuses to overwrite an existing corrupt prepared object', () => {
    const d = dir(), imported = importSample(d, sourceFile(d)), spec = recipe(imported.normalizedId), first = prepareSample(d, spec);
    writeFileSync(first.objectPath, 'broken');
    expect(() => prepareSample(d, spec)).toThrowError(expect.objectContaining({ code: 'E_VERIFY' }));
    expect(readFileSync(first.objectPath, 'utf8')).toBe('broken');
  });
});
