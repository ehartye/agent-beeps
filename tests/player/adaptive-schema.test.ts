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

  it('flags a track listed twice within the same layer', () => {
    const twiceInLayer = issues({ loop: true, adaptive: { ...adaptive, layers: { bed: ['pad', 'pad'], pulse: ['hat'] } } });
    expect(twiceInLayer).toContainEqual(expect.objectContaining({ pointer: '/adaptive/layers/bed/1', message: 'track "pad" is listed twice in layer "bed"' }));
  });

  it('flags a layer listed twice within the same state', () => {
    const twiceInState = issues({ loop: true, adaptive: { ...adaptive, states: { calm: ['bed', 'bed'] } } });
    expect(twiceInState).toContainEqual(expect.objectContaining({ pointer: '/adaptive/states/calm/1', message: 'layer "bed" is listed twice in state "calm"' }));
  });

  it('rejects prototype-chain names like "constructor" as a state', () => {
    expect(issues({ loop: true, adaptive: { ...adaptive, initial: 'constructor' } }))
      .toContainEqual(expect.objectContaining({ pointer: '/adaptive/initial', message: 'no state "constructor"' }));
  });

  it('falls back to "(none defined)" for empty layer/state hint lists', () => {
    const noLayers = issues({ loop: true, adaptive: { layers: {}, states: { calm: ['bed'] }, initial: 'calm' } });
    expect(noLayers).toContainEqual(expect.objectContaining({ pointer: '/adaptive/states/calm/0', message: 'no layer "bed"', hint: 'layers: (none defined)' }));
    const noStates = issues({ loop: true, adaptive: { layers: { bed: ['pad'], pulse: ['hat'] }, states: {}, initial: 'calm' } });
    expect(noStates).toContainEqual(expect.objectContaining({ pointer: '/adaptive/initial', message: 'no state "calm"', hint: 'states: (none defined)' }));
  });

  it('requires initial to be a valid identifier name', () => {
    const r = parseSong(songInput({ loop: true, adaptive: { ...adaptive, initial: 'Boss Fight' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContainEqual(expect.objectContaining({ pointer: '/adaptive/initial', message: expect.stringMatching(/lowercase letters, digits and dashes/) }));
  });
});
