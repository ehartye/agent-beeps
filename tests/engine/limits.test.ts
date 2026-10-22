import { describe, expect, it } from 'vitest';
import { MAX_SAMPLE_FRAMES, MAX_SAMPLE_WAV_BYTES, MAX_SOURCE_FRAMES, SAMPLE_RATE_HZ } from '../../runtime/engine/limits.js';
import { SAMPLE_RATE } from '../../runtime/engine/offline.js';
import { dbToGain } from '../../runtime/engine/units.js';
import { PREPARED_MAX_FRAMES, SOURCE_MAX_FRAMES } from '../../src/samples/store.ts';

describe('engine limits and units', () => {
  it('keep the literal values the engine used to hard-code', () => {
    expect(SAMPLE_RATE_HZ).toBe(48000);
    expect(SAMPLE_RATE).toBe(48000);
    expect(MAX_SAMPLE_FRAMES).toBe(480000);
    expect(MAX_SOURCE_FRAMES).toBe(5760000);
    expect(MAX_SAMPLE_WAV_BYTES).toBe(44 + 480000 * 2 * 4);
  });
  it('are the ones the sample store enforces', () => {
    expect(PREPARED_MAX_FRAMES).toBe(MAX_SAMPLE_FRAMES);
    expect(SOURCE_MAX_FRAMES).toBe(MAX_SOURCE_FRAMES);
  });
  it('dbToGain is the 10 ** (db / 20) every file used to define', () => {
    for (const db of [-60, -18.5, -6, 0, 1.5, 6, 12]) expect(dbToGain(db)).toBe(10 ** (db / 20));
    expect(dbToGain(0)).toBe(1);
  });
});
