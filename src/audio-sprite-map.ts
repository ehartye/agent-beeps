// Engine-neutral, portable PCM sprite admission. Keep this closure independent of renderers and third-party packages.
import { BeepsError } from './errors.ts';

export const AUDIO_SPRITE_SCHEMA = 'beeps/audio-sprite@1' as const;
export const AUDIO_SPRITE_MAX_ENTRIES = 128;
export const AUDIO_SPRITE_MAX_INPUT_BYTES = 16 * 1024 * 1024;
export const AUDIO_SPRITE_MAX_WAV_BYTES = 64 * 1024 * 1024;
export const AUDIO_SPRITE_MAX_SAMPLE_RATE = 192000;
/** Part of the build key: changes to packing policy require a new version. */
export const AUDIO_SPRITE_PACKING_VERSION = 1;

export interface AudioSpriteEntry {
  id: string;
  startFrame: number;
  endFrame: number;
  loop: boolean;
  sourceSha256: string;
  sourceFrames: number;
}

export interface AudioSpriteMap {
  schema: typeof AUDIO_SPRITE_SCHEMA;
  sampleRate: number;
  channels: 1 | 2;
  frames: number;
  gapFrames: number;
  audio: { file: string; sha256: string; encoding: 'pcm_s16le' };
  entries: AudioSpriteEntry[];
}

const fail = (message: string): never => { throw new BeepsError('E_SCHEMA', `audio sprite: ${message}`); };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

function object(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) fail(`${name} has malformed or unknown fields`);
  return value as Record<string, unknown>;
}

export function admitAudioSpriteEntryId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)
    || id === 'constructor' || id === 'prototype' || id === '__proto__') fail('entry id must be an ASCII letter followed by letters, digits, underscore or hyphen (at most 64 characters), excluding reserved IDs');
}

export function admitAudioSpriteFile(file: unknown): asserts file is string {
  if (typeof file !== 'string' || !/^[^\\/:*?"<>|\x00-\x1f]+\.wav$/i.test(file)
    || file.includes('..') || /[. ]$/.test(file) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(file)) fail('audio.file must be a portable same-directory WAV basename');
}

/** Strictly validates the entire frame map, including source and packed size limits. It does not authenticate file bytes. */
export function validateAudioSpriteMap(value: unknown): AudioSpriteMap {
  const map = object(value, ['schema', 'sampleRate', 'channels', 'frames', 'gapFrames', 'audio', 'entries'], 'map');
  if (map.schema !== AUDIO_SPRITE_SCHEMA) fail('unsupported schema');
  if (!integer(map.sampleRate, 1, AUDIO_SPRITE_MAX_SAMPLE_RATE)) fail('sampleRate is outside the supported integer range');
  if (map.channels !== 1 && map.channels !== 2) fail('channels must be 1 or 2');
  const sampleRate = map.sampleRate as number, channels = map.channels as 1 | 2;
  const maxFrames = Math.floor((AUDIO_SPRITE_MAX_WAV_BYTES - 44) / (2 * channels));
  if (!integer(map.frames, 1, maxFrames)) fail('frames exceed the packed WAV size limit');
  if (!integer(map.gapFrames, 1, Math.ceil(AUDIO_SPRITE_MAX_SAMPLE_RATE / 10)) || map.gapFrames !== Math.ceil(sampleRate / 10)) fail('gapFrames must equal ceil(sampleRate / 10)');
  const audio = object(map.audio, ['file', 'sha256', 'encoding'], 'audio');
  admitAudioSpriteFile(audio.file);
  if (audio.encoding !== 'pcm_s16le' || !hash(audio.sha256)) fail('audio requires pcm_s16le encoding and a lowercase SHA-256');
  if (!Array.isArray(map.entries) || map.entries.length < 1 || map.entries.length > AUDIO_SPRITE_MAX_ENTRIES) fail('entries must contain 1–128 items');
  const seen = new Set<string>();
  let next = 0;
  for (const value of map.entries as unknown[]) {
    const entry = object(value, ['id', 'startFrame', 'endFrame', 'loop', 'sourceSha256', 'sourceFrames'], 'entry');
    admitAudioSpriteEntryId(entry.id);
    if (seen.has(entry.id)) fail(`duplicate entry id "${entry.id}"`);
    seen.add(entry.id);
    if (!integer(entry.startFrame, 0, maxFrames) || !integer(entry.endFrame, 1, maxFrames)
      || !integer(entry.sourceFrames, 1, Math.floor((AUDIO_SPRITE_MAX_INPUT_BYTES - 44) / (2 * channels)))
      || entry.startFrame !== next || entry.endFrame - entry.startFrame !== entry.sourceFrames) fail(`entry "${entry.id}" has invalid frame boundaries or source size`);
    if (typeof entry.loop !== 'boolean' || !hash(entry.sourceSha256)) fail(`entry "${entry.id}" requires a boolean loop and a lowercase source SHA-256`);
    next = (entry.endFrame as number) + (map.gapFrames as number);
  }
  if (next - (map.gapFrames as number) !== map.frames) fail('last entry end must equal frames');
  return value as AudioSpriteMap;
}
