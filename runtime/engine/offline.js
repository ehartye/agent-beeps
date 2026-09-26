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
