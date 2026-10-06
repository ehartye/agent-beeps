// tests/player/player-types.test.ts
// The hand-written player.d.ts must describe the real module: this file only compiles (tsc --noEmit) if a
// consumer can use the documented API, and the runtime check keeps the type's method list equal to the object's.
import { expect, it } from 'vitest';
import { createPlayer, type AmbienceOptions, type Player } from '../../runtime/player/player.js';
import { asCtx, FakeContext } from '../helpers/fake-context.ts';

it('player.d.ts lists exactly the methods createPlayer returns', () => {
  const player: Player = createPlayer({ catalog: { assets: {} }, contextFactory: () => asCtx(new FakeContext()) as AudioContext });
  const slot: AmbienceOptions = { slot: 'weather', gainDb: -6, fadeSec: 4 };
  void player.ambience(null, slot);
  const declared = ['unlock', 'play', 'music', 'ambience', 'setState', 'setLevel', 'setEnabled', 'setHidden', 'stopAll', 'retry', 'inspect'].sort();
  expect(Object.keys(player).sort()).toEqual(declared);
});
