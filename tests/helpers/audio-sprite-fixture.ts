import { mkdirSync, writeFileSync } from 'node:fs';
import { writePcm16 } from '../../src/audio/post.ts';
import { makeFixture, type Fixture } from './build-fixture.ts';

/** Two distinct, exactly representable PCM entries: the second loops, in authored order. */
export function makeSpriteFixture(): Fixture {
  const fx = makeFixture({ config: { target: 'wav-master', jobs: 1 } });
  mkdirSync(fx.path('rendered'), { recursive: true });
  writeFileSync(fx.path('rendered/confirm.wav'), writePcm16({ sampleRate: 48000, channels: [Int16Array.from([0, -32768, 32767, 101, -9]), Int16Array.from([17, -5, 42, 789, -100])] }));
  writeFileSync(fx.path('rendered/cancel.wav'), writePcm16({ sampleRate: 48000, channels: [Int16Array.from([-1, 2, 300]), Int16Array.from([11, -22, 333])] }));
  fx.write('recipes.json', { 'ui-kit': { kind: 'sprite', role: 'sfx', entries: [{ id: 'confirm', source: 'rendered/confirm.wav' }, { id: 'cancel', source: 'rendered/cancel.wav', loop: true }] } });
  return fx;
}
