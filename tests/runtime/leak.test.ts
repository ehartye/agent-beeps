// The same claim as the recording-context test, on the real thing: in Chromium, a long session of fresh seeds leaves only the
// noise cache's byte budget of AudioBuffers alive (counted after a garbage collection, through the DevTools protocol) and
// frees every disposed voice's graph. The unbounded run is the control: without the bound the same session keeps one
// buffer per noise layer per play, so the instrument can fail.
import { describe, expect, it } from 'vitest';
import { chromiumAvailable } from '../../src/render/host.ts';
import { makeCue } from '../../src/runtime/cue.ts';
import { runPerf } from '../../src/runtime/harness.ts';
import { NOISE_CACHE_BYTES } from '../../runtime/engine/index.js';
import { example, exampleProject } from '../helpers/runtime-examples.ts';

const cue = makeCue(example('comet-blaster'), exampleProject(), 261026, -5.56); // two noise layers per play

describe.skipIf(!(await chromiumAvailable()))('fresh seeds in Chromium', () => {
  it('keep at most the noise cache budget of buffers and no disposed graph', async () => {
    const [bounded] = await runPerf([cue], { n: 1500, realtime: true, varySeed: true, dispose: true, memory: true });
    expect(bounded.noiseCache.bytes).toBeLessThanOrEqual(NOISE_CACHE_BYTES);
    expect(bounded.liveAudioBuffers!.mb).toBeLessThanOrEqual(NOISE_CACHE_BYTES / 1048576 + 1);
    expect(bounded.liveAudioBuffers!.count).toBeLessThan(60);
    expect(bounded.liveAudioNodes!).toBeLessThan(40); // the context's own nodes, not 47 per play
    const [unbounded] = await runPerf([cue], { n: 400, realtime: true, varySeed: true, dispose: true, memory: true, noiseLimit: 'inf' });
    expect(unbounded.liveAudioBuffers!.count).toBeGreaterThan(700);
    expect(unbounded.liveAudioBuffers!.mb).toBeGreaterThan(250);
  }, 240_000);
});
