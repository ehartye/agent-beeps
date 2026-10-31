/** @lane merge */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { packAudioSprite } from '../src/audio/sprite.ts';
import { validateAudioSpriteMap, type AudioSpriteMap } from '../src/audio-sprite-map.ts';
import { writePcm16 } from '../src/audio/post.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const source = (samples = [123, -321], sampleRate = 101, right?: number[]) => writePcm16({ sampleRate, channels: [Int16Array.from(samples), ...(right ? [Int16Array.from(right)] : [])] });
function fixture() {
  return [
    { id: 'Confirm_1', wav: source([-32768, -1, 1], 101, [32767, 0, 123]) },
    { id: 'cancel-2', wav: source([-7, 30000], 101, [7, -30000]), loop: true },
  ];
}

/** Independent of the PCM decoder and map validator: a literal declared frame/sample oracle. */
function exactFixture(wav: Buffer, map: AudioSpriteMap) {
  expect([map.sampleRate, map.channels, map.frames, map.gapFrames]).toEqual([101, 2, 16, 11]);
  expect(map.entries.map(entry => [entry.id, entry.startFrame, entry.endFrame, entry.sourceFrames, entry.loop])).toEqual([
    ['Confirm_1', 0, 3, 3, false], ['cancel-2', 14, 16, 2, true],
  ]);
  expect(wav.length).toBe(108);
  expect(wav.readUInt32LE(4)).toBe(100);
  expect(wav.readUInt32LE(40)).toBe(64);
  const integers = Array.from({ length: 32 }, (_, i) => wav.readInt16LE(44 + i * 2));
  expect(integers).toEqual([
    -32768, 32767, -1, 0, 1, 123,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    -7, 7, 30000, -30000,
  ]);
}

describe('PCM audio sprite packing', () => {
  it('preserves exact signed samples, order, zero gaps, hashes and deterministic bytes', () => {
    const inputs = fixture(), before = inputs.map(entry => Buffer.from(entry.wav));
    const a = packAudioSprite(inputs, 'ui-kit.wav'), b = packAudioSprite(inputs, 'ui-kit.wav');
    exactFixture(a.wav, a.map);
    expect(a.wav.equals(b.wav)).toBe(true);
    expect(a.mapText).toBe(b.mapText);
    expect(JSON.parse(a.mapText)).toEqual(a.map);
    expect(a.map.audio).toEqual({ file: 'ui-kit.wav', sha256: hash(a.wav), encoding: 'pcm_s16le' });
    expect(a.map.entries.map(entry => entry.sourceSha256)).toEqual(inputs.map(entry => hash(entry.wav)));
    expect(inputs.map(entry => entry.wav)).toEqual(before);
  });

  it('detects a changed start boundary with the independent range witness', () => {
    const packed = packAudioSprite(fixture(), 'ui-kit.wav'), altered = structuredClone(packed.map);
    altered.entries[1].startFrame = 13;
    expect(() => exactFixture(packed.wav, altered)).toThrow(/expected/);
  });

  it('detects a changed source sample even when its new map and hashes are internally valid', () => {
    const inputs = fixture();
    inputs[0].wav.writeInt16LE(-32767, 44);
    const altered = packAudioSprite(inputs, 'ui-kit.wav');
    expect(validateAudioSpriteMap(altered.map)).toEqual(altered.map);
    expect(() => exactFixture(altered.wav, altered.map)).toThrow(/expected/);
  });

  it('has no leading or trailing gap for a single mono entry', () => {
    const wav = source([32767, -32768, 0], 192000);
    const packed = packAudioSprite([{ id: 'A', wav }], 'single.wav');
    expect(packed.wav.equals(wav)).toBe(true);
    expect(packed.map.entries[0]).toMatchObject({ startFrame: 0, endFrame: 3, sourceFrames: 3, loop: false });
    expect(packed.map.gapFrames).toBe(19200);
  });

  it('admits the declared 128-entry and 64-character ID boundaries', () => {
    const wav = source([42], 1);
    const inputs = Array.from({ length: 128 }, (_, i) => ({ id: i ? `E${i}` : 'A'.repeat(64), wav }));
    expect(packAudioSprite(inputs, 'many.wav').map.frames).toBe(255);
  });

  it.each(['constructor', 'prototype', '__proto__', '', '0start', 'a b', 'a.b', 'é', 'A'.repeat(65)])('rejects entry ID %s', id => {
    expect(() => packAudioSprite([{ id, wav: source() }], 'sound.wav')).toThrow(/entry id/);
  });

  it('rejects duplicate entry IDs', () => {
    expect(() => packAudioSprite([{ id: 'A', wav: source() }, { id: 'A', wav: source() }], 'sound.wav')).toThrow(/duplicate/);
  });

  it.each([0, 129])('rejects %s entries', count => {
    expect(() => packAudioSprite(Array.from({ length: count }, (_, i) => ({ id: `A${i}`, wav: source() })), 'sound.wav')).toThrow(/1–128/);
  });

  it.each([
    ['mixed sample rates', source([1], 100)],
    ['mixed channel counts', source([1], 101, [1])],
  ])('rejects %s', (_name, wav) => {
    expect(() => packAudioSprite([{ id: 'A', wav: source() }, { id: 'B', wav }], 'sound.wav')).toThrow(/same sample rate and channel count/);
  });

  it.each([
    ['empty audio', source([])],
    ['high sample rate', source([1], 192001)],
    ['three channels', writePcm16({ sampleRate: 101, channels: [new Int16Array([1]), new Int16Array([2]), new Int16Array([3])] })],
  ])('rejects %s', (_name, wav) => {
    expect(() => packAudioSprite([{ id: 'A', wav }], 'sound.wav')).toThrow(/nonempty mono\/stereo/);
  });

  it('rejects non-boolean loop flags', () => {
    expect(() => packAudioSprite([{ id: 'A', wav: source(), loop: 1 as unknown as boolean }], 'sound.wav')).toThrow(/loop must be boolean/);
  });

  it('rejects oversized input before inspecting its header', () => {
    expect(() => packAudioSprite([{ id: 'A', wav: Buffer.alloc(16 * 1024 * 1024 + 1) }], 'sound.wav')).toThrow(/16 MiB/);
  });

  it('rejects a packed file exceeding 64 MiB including header and gaps', () => {
    // Four maximum-size canonical sources plus 63 frames and four one-frame gaps exceed the packed limit by two bytes.
    const maximum = Buffer.alloc(16 * 1024 * 1024);
    source([0], 10).copy(maximum, 0, 0, 44);
    maximum.writeUInt32LE(maximum.length - 8, 4); maximum.writeUInt32LE(maximum.length - 44, 40);
    const inputs: { id: string; wav: Buffer }[] = Array.from({ length: 4 }, (_, i) => ({ id: `A${i}`, wav: maximum }));
    inputs.push({ id: 'last', wav: source(Array(63).fill(0), 10) });
    expect(() => packAudioSprite(inputs, 'sound.wav')).toThrow(/64 MiB/);
  });
});

describe('portable audio sprite map admission', () => {
  it.each([
    ['schema', (m: any) => { m.schema = 'beeps/audio-sprite@2'; }],
    ['unknown field', (m: any) => { m.resources = []; }],
    ['fractional sample rate', (m: any) => { m.sampleRate = 101.5; }],
    ['sample rate limit', (m: any) => { m.sampleRate = 192001; }],
    ['zero channels', (m: any) => { m.channels = 0; }],
    ['noninteger channels', (m: any) => { m.channels = 1.5; }],
    ['unsafe frames', (m: any) => { m.frames = Number.MAX_SAFE_INTEGER + 1; }],
    ['packed size limit', (m: any) => { m.frames = 64 * 1024 * 1024; }],
    ['wrong gap', (m: any) => { m.gapFrames = 10; }],
    ['uppercase audio hash', (m: any) => { m.audio.sha256 = 'A'.repeat(64); }],
    ['wrong encoding', (m: any) => { m.audio.encoding = 'pcm_f32le'; }],
    ['path traversal', (m: any) => { m.audio.file = '../sound.wav'; }],
    ['Windows path', (m: any) => { m.audio.file = 'x\\sound.wav'; }],
    ['URL', (m: any) => { m.audio.file = 'https://host/sound.wav'; }],
    ['wrong extension', (m: any) => { m.audio.file = 'sound.mp3'; }],
    ['missing audio hash', (m: any) => { delete m.audio.sha256; }],
    ['empty entries', (m: any) => { m.entries = []; }],
    ['too many entries', (m: any) => { m.entries = Array(129).fill(m.entries[0]); }],
    ['duplicate ID', (m: any) => { m.entries[1].id = m.entries[0].id; }],
    ['reserved ID', (m: any) => { m.entries[0].id = 'constructor'; }],
    ['out of order', (m: any) => { m.entries.reverse(); }],
    ['leading gap', (m: any) => { m.entries[0].startFrame = 1; }],
    ['overlap', (m: any) => { m.entries[1].startFrame = 2; }],
    ['fractional range', (m: any) => { m.entries[1].endFrame = 15.5; }],
    ['source length mismatch', (m: any) => { m.entries[0].sourceFrames = 2; }],
    ['source size limit', (m: any) => { m.entries[0].sourceFrames = 16 * 1024 * 1024; }],
    ['trailing gap', (m: any) => { m.frames = 17; }],
    ['bad source hash', (m: any) => { m.entries[0].sourceSha256 = 'bogus'; }],
    ['nonboolean loop', (m: any) => { m.entries[0].loop = 0; }],
    ['unknown entry field', (m: any) => { m.entries[0].start = 0; }],
  ])('rejects %s', (_name, mutate) => {
    const map = structuredClone(packAudioSprite(fixture(), 'ui-kit.wav').map);
    mutate(map);
    expect(() => validateAudioSpriteMap(map)).toThrow(/audio sprite/);
  });

  it.each([null, [], 'beeps/audio-sprite@1', {}])('rejects a malformed root %j', value => {
    expect(() => validateAudioSpriteMap(value)).toThrow(/malformed/);
  });
});
