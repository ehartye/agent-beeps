import { describe, expect, it } from 'vitest';
import { buildSource } from '../../runtime/engine/sources.js';
import { SOURCE_TYPES } from '../../src/schema/patch.ts';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { withSource } from '../helpers/patches.ts';

const asset = `sha256:${'b'.repeat(64)}`;

// A Record over SOURCE_TYPES: adding a source type to the schema fails to compile until it has an example here,
// and the loop below fails until the engine builds it.
const EXAMPLES: Record<(typeof SOURCE_TYPES)[number], Record<string, unknown>> = {
  osc: { type: 'osc', wave: 'sine', pitch: 220 },
  noise: { type: 'noise', color: 'pink' },
  fm: { type: 'fm', pitch: 220, operators: [{ ratio: 1 }, { ratio: 2, index: 2 }], algorithm: [[1, 0]] },
  additive: { type: 'additive', pitch: 220, partials: [[1, 0, 0.5], [2, -6, 0.3]] },
  modal: { type: 'modal', pitch: 220, modes: [[1, 40, 0], [2.4, 30, -6]], exciter: 'impulse' },
  grains: { type: 'grains', rate: 40, grainDecay: 0.01, center: 1500, q: 1 },
  metal: { type: 'metal', base: 300, bands: [3000, 5000] },
  voice: { type: 'voice', pitch: 200, formants: [[700, 5, 0], [1200, 5, -3]] },
  sample: { type: 'sample', asset },
};

describe('engine source types', () => {
  it.each(SOURCE_TYPES)('builds a %s source into at least one audio node', type => {
    const f = new FakeContext();
    const source = withSource(EXAMPLES[type]).layers[0].source;
    const samples = type === 'sample' ? { [asset]: f.createBuffer(2, 4800, 48000) as unknown as AudioBuffer } : undefined;
    buildSource(asCtx(f), source, { pitchHz: 220, seed: 1, length: 0.5, samples });
    // The mix gain is always created; a source that built nothing else would sound as silence.
    expect(f.created.length, type).toBeGreaterThan(1);
  });

  it('refuses a source type it does not know instead of returning silence', () => {
    const source = { ...withSource(EXAMPLES.osc).layers[0].source, type: 'wavetable' } as never;
    expect(() => buildSource(asCtx(new FakeContext()), source, { pitchHz: 220, seed: 1, length: 0.5 })).toThrow(/unknown source type "wavetable"/);
  });
});
