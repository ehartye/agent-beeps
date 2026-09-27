// tests/player/adaptive-schema.test.ts
import { describe, expect, it } from 'vitest';
import { parseSong } from '../../src/schema/song.ts';
import { songInput } from '../helpers/songs.ts';

const adaptive = { layers: { bed: ['pad'], pulse: ['hat'] }, states: { calm: ['bed'], full: ['bed', 'pulse'] }, initial: 'calm' };
const issues = (over: Record<string, unknown>) => { const r = parseSong(songInput(over)); return r.ok ? [] : r.issues; };

describe('adaptive songs', () => {
  it('accepts layers that partition the tracks, states over those layers and an initial state', () => {
    expect(issues({ loop: true, adaptive })).toEqual([]);
  });

  it('requires a loop', () => {
    expect(issues({ adaptive })).toContainEqual(expect.objectContaining({ pointer: '/adaptive', message: expect.stringMatching(/loop/) }));
  });

  it('puts every track in exactly one layer', () => {
    const twice = issues({ loop: true, adaptive: { ...adaptive, layers: { bed: ['pad', 'hat'], pulse: ['hat'] } } });
    expect(twice).toContainEqual(expect.objectContaining({ pointer: '/adaptive/layers/pulse/0', message: expect.stringMatching(/already in layer "bed"/) }));
    const none = issues({ loop: true, adaptive: { ...adaptive, layers: { bed: ['pad'] }, states: { calm: ['bed'] } } });
    expect(none).toContainEqual(expect.objectContaining({ pointer: '/adaptive/layers', message: 'track "hat" is in no layer' }));
    const unknown = issues({ loop: true, adaptive: { ...adaptive, layers: { bed: ['pad', 'lead'], pulse: ['hat'] } } });
    expect(unknown).toContainEqual(expect.objectContaining({ pointer: '/adaptive/layers/bed/1', message: 'no track "lead"' }));
  });

  it('checks state layers and the initial state', () => {
    expect(issues({ loop: true, adaptive: { ...adaptive, states: { calm: ['bed', 'drums'] } } }))
      .toContainEqual(expect.objectContaining({ pointer: '/adaptive/states/calm/1', message: 'no layer "drums"' }));
    expect(issues({ loop: true, adaptive: { ...adaptive, initial: 'boss' } }))
      .toContainEqual(expect.objectContaining({ pointer: '/adaptive/initial', message: 'no state "boss"' }));
  });
});
