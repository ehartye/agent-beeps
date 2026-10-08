// Offline song renders hold their nodes (retain.js) and pin the channel count of every long-lived input (song.js `pinned`).
// tests/render/song-determinism.test.ts shows the effect in Chromium with collections forced; this is the fast structural guard.
import { describe, expect, it } from 'vitest';
import { recordNodes } from '../../runtime/engine/retain.js';
import { buildSong, patchIsStereo } from '../../runtime/engine/song.js';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { patch } from '../helpers/patches.ts';
import { HAT, PAD, song } from '../helpers/songs.ts';

const SONG = (tracks: Record<string, unknown>, extra: Record<string, unknown> = {}) => song({
  master: { reverb: { preset: 'room' }, delay: { beats: 0.75 } },
  tracks,
  patterns: { 'pad-a': { bars: 2, chords: { progression: 'a', octave: 4 } }, 'hat-a': { bars: 1, steps: 'x.x.x.x.x.x.x.x.' } },
  sections: { a: { bars: 2, play: { pad: 'pad-a', hat: 'hat-a' } } },
  ...extra,
});
const pinned = (f: FakeContext) => f.created.filter(n => n.channelCountMode === 'explicit');

describe('recordNodes', () => {
  it('collects every node the context creates while recording, leaves buffers out, and restores the context', () => {
    const f = new FakeContext();
    const before = f.createGain();
    const rec = recordNodes(asCtx(f));
    const g = f.createGain(), o = f.createOscillator();
    f.createBuffer(1, 10, 48000);
    const got = rec.stop();
    f.createGain();
    expect(got).toEqual([g, o]);
    expect(before).not.toBe(g);
    expect(Object.hasOwn(f, 'createGain')).toBe(false);
    expect(f.created).toHaveLength(4);
  });
});

describe('buildSong retain', () => {
  const instruments = { pad: patch(PAD), hat: patch(HAT) };
  const tracks = { pad: { instrument: PAD, sends: { reverb: -6, delay: -8 } }, hat: { instrument: HAT } };

  it('holds the song graph and each note until a second after it ends, then lets the note go', () => {
    const f = new FakeContext();
    const b = buildSong(asCtx(f), SONG(tracks), instruments, { lazy: true, retain: true });
    expect(b.graph!.length).toBeGreaterThan(10);
    expect(b.graph!.every(n => f.created.includes(n as any))).toBe(true);
    const made = f.created.length;
    expect(b.advance(1)).toBeGreaterThan(0);
    expect(f.created.length).toBeGreaterThan(made);
    expect(b.release(0.5)).toBe(0);
    expect(b.release(60)).toBeGreaterThan(0);
    expect(b.release(60)).toBe(0);
    expect(Object.hasOwn(f, 'createGain')).toBe(false);
  });

  it('retains nothing unless asked', () => {
    const f = new FakeContext();
    const b = buildSong(asCtx(f), SONG(tracks), instruments, { lazy: true });
    expect(b.graph).toBeUndefined();
    b.advance(1);
    expect(b.release(60)).toBe(0);
  });
});

describe('channel counts of long-lived inputs', () => {
  const instruments = { pad: patch(PAD), hat: patch(HAT) };

  it('pins the master effect inputs and every track bus; a bus is stereo only when a note or its patch can be', () => {
    const f = new FakeContext();
    // The pad's chords are spread (voices are panned); the hat is a mono patch with no spread.
    buildSong(asCtx(f), SONG({ pad: { instrument: PAD, spread: 0.6 }, hat: { instrument: HAT, pan: -0.1 } }), instruments);
    const counts = pinned(f).map(n => n.channelCount).sort();
    expect(counts).toEqual([1, 2, 2, 2]); // hat bus, pad bus, reverb input, delay input
    expect(pinned(f).every(n => n.channelInterpretation === 'speakers')).toBe(true);
  });

  it('a mono track stays mono and a stereo patch makes its bus stereo', () => {
    const wide = patch({ ...PAD, name: 'wide', layers: [{ ...PAD.layers[0], pan: 0.3 }] });
    const hiss = patch({ ...HAT, name: 'hiss', layers: [{ ...HAT.layers[0], source: { type: 'noise', color: 'white', stereo: true } }] });
    expect(patchIsStereo(patch(PAD))).toBe(false);
    expect(patchIsStereo(wide)).toBe(true);
    expect(patchIsStereo(hiss)).toBe(true);
    const f = new FakeContext();
    buildSong(asCtx(f), SONG({ pad: { instrument: wide }, hat: { instrument: HAT } }), { pad: wide, hat: patch(HAT) });
    expect(pinned(f).map(n => n.channelCount).sort()).toEqual([1, 2, 2, 2]);
  });
});
