import { describe, expect, it } from 'vitest';
import { mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as transport from '../../src/samples/transport.ts';
import { writeSampleObject } from '../../src/samples/store.ts';
import { sampleFixture } from '../helpers/samples.ts';
import { coin } from '../helpers/patches.ts';

describe('operation-scoped sample snapshots', () => {
  it('reuses one verified recording across variants but a new operation verifies the store again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-sample-snapshot-')), f = sampleFixture();
    const stored = writeSampleObject(dir, f.wav);
    const snapshot = transport.createSampleWavSnapshot(dir);
    expect(snapshot(f.patch)).toEqual(f.sampleWavs);
    unlinkSync(stored.path);
    const otherCue = { ...f.patch, name: 'other-cue' };
    expect(snapshot(otherCue)).toEqual(f.sampleWavs);
    expect(() => transport.createSampleWavSnapshot(dir)(f.patch)).toThrow(/not found/);
    expect(() => transport.resolveSampleWavs(f.patch, dir)).toThrow(/not found/);
    expect(transport.createSampleWavSnapshot()(coin())).toEqual({});
  });
});
