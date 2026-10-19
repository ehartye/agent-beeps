import { writeWav } from '../../src/audio/wav.ts';
import { sampleId } from '../../src/samples/store.ts';
import { patch } from './patches.ts';

export function sampleFixture({ hybrid = false, live = false, zero = false } = {}) {
  const pcm = [220, 337].map(hz => Float32Array.from({ length: 57600 }, (_, i) => zero ? 0 : Math.sin(i * 2 * Math.PI * hz / 48000) * 0.125));
  const wav = writeWav(pcm, 48000, { bits: 32 }), id = sampleId(wav);
  const p = patch({ schema: 'beeps/patch@1', name: hybrid ? 'hybrid-fixture' : 'sample-fixture', family: 'test', duration: 1.4,
    layers: [{ source: { type: 'sample', asset: id }, start: 0.0125, amp: { attack: 0, decay: 0, sustain: 1, release: 0.025 } },
      ...(hybrid ? [{ source: { type: 'noise', color: 'pink' }, gainDb: -24, amp: { attack: 0.005, decay: 0.2, sustain: 0, release: 0.05 } }] : [])],
    ...(live ? { xRuntime: { inputs: { level: { min: 0, max: 1, default: 0 } }, bind: [{ input: 'level', target: '/layers/0/gainDb', range: [0, -12], live: true }] } } : {}),
  });
  return { pcm, wav, id, patch: p, sampleWavs: { [id]: wav.toString('base64') } };
}
