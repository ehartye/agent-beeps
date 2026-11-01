// Exact PCM concatenation only: no normalization, resampling, codec conversion or filesystem publication.
import { createHash } from 'node:crypto';
import { BeepsError } from '../errors.ts';
import {
  AUDIO_SPRITE_SCHEMA, AUDIO_SPRITE_MAX_ENTRIES, AUDIO_SPRITE_MAX_INPUT_BYTES,
  AUDIO_SPRITE_MAX_WAV_BYTES, AUDIO_SPRITE_MAX_SAMPLE_RATE,
  admitAudioSpriteEntryId, admitAudioSpriteFile, validateAudioSpriteMap,
  type AudioSpriteMap,
} from '../audio-sprite-map.ts';
import { inspectPcm16 } from './post.ts';

export interface AudioSpriteInput { id: string; wav: Buffer; loop?: boolean }
export interface PackedAudioSprite { wav: Buffer; map: AudioSpriteMap; mapText: string }
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Validate every source and total size before allocating output. File callers must also bound reads to MAX_INPUT_BYTES. */
export function packAudioSprite(inputs: readonly AudioSpriteInput[], audioFile: string): PackedAudioSprite {
  const fail = (message: string): never => { throw new BeepsError('E_SCHEMA', `audio sprite: ${message}`); };
  admitAudioSpriteFile(audioFile);
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > AUDIO_SPRITE_MAX_ENTRIES) fail('entries must contain 1–128 items');
  const seen = new Set<string>();
  let sampleRate = 0, channels = 0, frames = 0, gapFrames = 0;
  const entries = inputs.map((input, index) => {
    if (!input || typeof input !== 'object') fail('malformed source entry');
    admitAudioSpriteEntryId(input.id);
    if (seen.has(input.id)) fail(`duplicate entry id "${input.id}"`);
    seen.add(input.id);
    if (input.loop !== undefined && typeof input.loop !== 'boolean') fail(`entry "${input.id}" loop must be boolean`);
    if (!Buffer.isBuffer(input.wav) || input.wav.length > AUDIO_SPRITE_MAX_INPUT_BYTES) fail(`entry "${input.id}" exceeds the 16 MiB input WAV limit`);
    const pcm = inspectPcm16(input.wav);
    if (pcm.channels > 2 || pcm.sampleRate > AUDIO_SPRITE_MAX_SAMPLE_RATE || pcm.frames < 1) fail(`entry "${input.id}" requires nonempty mono/stereo PCM16 at 1–192000 Hz`);
    if (index === 0) {
      sampleRate = pcm.sampleRate; channels = pcm.channels; gapFrames = Math.ceil(sampleRate / 10);
    } else if (sampleRate !== pcm.sampleRate || channels !== pcm.channels) fail('all entries must have the same sample rate and channel count');
    const startFrame = frames + (index ? gapFrames : 0);
    frames = startFrame + pcm.frames;
    const bytes = 44 + frames * channels * 2;
    if (!Number.isSafeInteger(bytes) || bytes > AUDIO_SPRITE_MAX_WAV_BYTES) fail('packed WAV exceeds the 64 MiB size limit');
    return { id: input.id, startFrame, endFrame: frames, loop: input.loop ?? false, sourceSha256: sha256(input.wav), sourceFrames: pcm.frames };
  });
  // All headers are canonical and formats match; copy the first header and only alter its size fields.
  const wav = Buffer.alloc(44 + frames * channels * 2);
  inputs[0].wav.copy(wav, 0, 0, 44);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < inputs.length; i++) inputs[i].wav.copy(wav, 44 + entries[i].startFrame * channels * 2, 44);
  const map = validateAudioSpriteMap({
    schema: AUDIO_SPRITE_SCHEMA, sampleRate, channels, frames, gapFrames,
    audio: { file: audioFile, sha256: sha256(wav), encoding: 'pcm_s16le' }, entries,
  });
  return { wav, map, mapText: JSON.stringify(map, null, 2) + '\n' };
}
