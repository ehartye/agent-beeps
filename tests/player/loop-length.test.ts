// The catalog's exact frame count guards loops: a decoder that leaves frames after the audio ends the loop where the audio ends,
// and any length that differs from the catalog is reported once.
import { describe, expect, it } from 'vitest';
import { createPlayer } from '../../runtime/player/player.js';
import { asCtx, FakeContext } from '../helpers/fake-context.ts';

// The fake context decodes everything to 4800 frames at 48 kHz.
const catalog = { assets: {
  exact: { file: 'exact.ogg', loop: true, frames: 4800 },
  long: { file: 'long.ogg', loop: true, frames: 4000 },
  short: { file: 'short.ogg', loop: true, frames: 5000 },
  legacy: { file: 'legacy.ogg', loop: true },
  layered: { file: 'layered.ogg', loop: true, frames: 4000, bpm: 120, meter: 4, durationSec: 4000 / 48000,
    layers: [{ name: 'bed', file: 'layered.bed.ogg' }, { name: 'pulse', file: 'layered.pulse.ogg' }], states: { calm: ['bed'], full: ['bed', 'pulse'] }, initialState: 'calm' },
} };

function setup() {
  const ctx = new FakeContext();
  const errors: { code: string; message: string; id?: string }[] = [];
  const player = createPlayer({
    catalog: '/audio/index.json', contextFactory: () => asCtx(ctx) as AudioContext,
    fetcher: async () => ({ ok: true, json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(8) }),
    onError: (e: { code: string; message: string; id?: string }) => errors.push(e),
  });
  return { ctx, player, errors };
}
const settle = () => new Promise(r => setTimeout(r, 0));

describe('loop length guard', () => {
  it('sets loopEnd when the decoder left extra frames, and says so once', async () => {
    const { ctx, player, errors } = setup();
    await player.unlock();
    await player.music('long');
    await settle();
    expect(ctx.nodes('bufferSource').map(n => n.loopEnd)).toEqual([4000 / 48000]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'W_LOOP_LENGTH', id: 'long' });
    expect(errors[0].message).toMatch(/4800 frames, the catalog says 4000/);
    await player.music('long');
    await settle();
    expect(errors).toHaveLength(1); // once per asset
  });

  it('does nothing when the length is exact or the catalog has no frames', async () => {
    const { ctx, player, errors } = setup();
    await player.unlock();
    await player.music('exact'); await settle();
    await player.music('legacy'); await settle();
    expect(ctx.nodes('bufferSource').every(n => n.loopEnd === undefined)).toBe(true);
    expect(errors).toEqual([]);
  });

  it('warns, without loopEnd, when the decoder trimmed audio', async () => {
    const { ctx, player, errors } = setup();
    await player.unlock();
    await player.music('short'); await settle();
    expect(ctx.nodes('bufferSource').every(n => n.loopEnd === undefined)).toBe(true);
    expect(errors[0]).toMatchObject({ code: 'W_LOOP_LENGTH', id: 'short' });
    expect(errors[0].message).toMatch(/trimmed/);
  });

  it('guards every layer of an adaptive bed', async () => {
    const { ctx, player, errors } = setup();
    await player.unlock();
    await player.music('layered'); await settle();
    expect(ctx.nodes('bufferSource').map(n => n.loopEnd)).toEqual([4000 / 48000, 4000 / 48000]);
    expect(errors).toHaveLength(1);
  });
});
