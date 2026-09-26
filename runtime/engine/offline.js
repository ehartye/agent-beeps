// Offline render in the browser: the delivered (trimmed, limited) stereo mix and the authored
// (pre-trim, pre-limiter) stereo tap, rendered together into one 4-channel OfflineAudioContext.
import { buildPatch, patchLength } from './patch.js';

export const SAMPLE_RATE = 48000;
const PAD = 0.05;

/** @typedef {import('../../src/schema/patch.ts').Patch} Patch */

/** @param {Float32Array} f */
export function toBase64(f) {
  const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * @param {Patch} patch
 * @param {{ seed?: number, variant?: number, trimDb?: number, scale?: import('./layer.js').Scale }} [opts]
 */
export async function renderOfflinePcm(patch, opts = {}) {
  const length = Math.ceil((patchLength(patch) + PAD) * SAMPLE_RATE);
  const ctx = new OfflineAudioContext(4, length, SAMPLE_RATE);
  ctx.destination.channelInterpretation = 'discrete';
  const merger = ctx.createChannelMerger(4);
  merger.connect(ctx.destination);

  /** @param {number} offset */
  const stereoInto = offset => {
    const bus = ctx.createGain();
    bus.channelCount = 2;
    bus.channelCountMode = 'explicit';
    bus.channelInterpretation = 'speakers'; // mono sources upmix to both sides
    const split = ctx.createChannelSplitter(2);
    bus.connect(split);
    split.connect(merger, 0, offset);
    split.connect(merger, 1, offset + 1);
    return bus;
  };
  const delivered = stereoInto(0);
  const authored = stereoInto(2);
  buildPatch(ctx, patch, { ...opts, destination: delivered, authoredTap: authored });
  const buf = await ctx.startRendering();
  return {
    sampleRate: SAMPLE_RATE,
    delivered: [buf.getChannelData(0), buf.getChannelData(1)],
    authored: [buf.getChannelData(2), buf.getChannelData(3)],
  };
}

/** Same as renderOfflinePcm, with channels base64-encoded for transfer out of the page. */
export async function renderOffline(/** @type {Patch} */ patch, /** @type {any} */ opts = {}) {
  const r = await renderOfflinePcm(patch, opts);
  return { sampleRate: r.sampleRate, delivered: r.delivered.map(toBase64), authored: r.authored.map(toBase64) };
}

/** Rendered songs kept in the page until the CLI has pulled them: too big for one transfer. */
const songs = /** @type {Map<number, Float32Array[]>} */ (new Map());
let nextSong = 1;

/**
 * Render a song to stereo PCM and keep it in the page. Loop songs fold their tail onto the start,
 * so the returned buffer is exactly one loop long and plays seamlessly on repeat.
 * @param {import('../../src/schema/song.ts').Song} song
 * @param {Record<string, Patch>} instruments
 */
export async function renderSongOffline(song, instruments) {
  const { compileSong } = await import('./sequence.js');
  const { buildSong, songTail } = await import('./song.js');
  const { length: formLength, sections } = compileSong(song);
  const total = Math.ceil((formLength + songTail(song, instruments)) * SAMPLE_RATE);
  const ctx = new OfflineAudioContext(2, total, SAMPLE_RATE);
  const built = buildSong(ctx, song, instruments, { lazy: true });
  // Build notes a window ahead of the render position, suspending at each window edge.
  const WINDOW = 2, AHEAD = 1;
  built.advance(WINDOW + AHEAD);
  const quantum = 128 / SAMPLE_RATE;
  for (let t = WINDOW; t < formLength; t += WINDOW) {
    const at = Math.round(t / quantum) * quantum;
    ctx.suspend(at).then(() => { built.advance(at + WINDOW + AHEAD); ctx.resume(); });
  }
  const buf = await ctx.startRendering();
  let channels = [buf.getChannelData(0), buf.getChannelData(1)];
  if (song.loop) {
    const n = Math.round(formLength * SAMPLE_RATE);
    channels = channels.map(ch => {
      const out = ch.slice(0, n);
      for (let i = n; i < ch.length; i++) out[i % n] += ch[i];
      return out;
    });
  }
  const id = nextSong++;
  songs.set(id, channels);
  return { id, sampleRate: SAMPLE_RATE, frames: channels[0].length, sections };
}

/** @param {number} id @param {number} channel @param {number} start @param {number} count */
export function songChunk(id, channel, start, count) {
  const chs = songs.get(id);
  if (!chs) throw new Error(`no rendered song ${id}`);
  return toBase64(chs[channel].subarray(start, start + count));
}

/** @param {number} id */
export function songChannels(id) {
  const chs = songs.get(id);
  if (!chs) throw new Error(`no rendered song ${id}`);
  return chs;
}

/** @param {number} id */
export function freeSong(id) { songs.delete(id); }
