// A generated candidate says what it renders: sampled pitches are snapped to the project scale, so `generate` no longer hands back patches
// that carry an N_SCALE_SNAP notice from the first render.
import { describe, expect, it } from 'vitest';
import { getArchetype, loadArchetypes, sampleArchetype } from '../src/archetypes.ts';
import { scaleSnapNotices } from '../src/patch-notices.ts';
import { defaultProject, type Scale } from '../src/schema/project.ts';
import { chromiumAvailable } from '../src/render/host.ts';
import { beeps, project } from './helpers/cli.ts';

const scale = defaultProject().scale;
const aMinor: Scale = { root: 'A', mode: 'minor', snap: true };
const pitchesOf = (p: ReturnType<typeof sampleArchetype>[number]) => p.layers.flatMap(l => [
  ...('pitch' in l.source && typeof l.source.pitch === 'number' ? [l.source.pitch] : []),
  ...(l.pitchEnv ?? []).flatMap(e => (typeof e.to === 'number' ? [e.to] : [])),
]);
const withoutPitches = (p: ReturnType<typeof sampleArchetype>[number]) => JSON.stringify(p, (k, v) => (k === 'pitch' || k === 'to' ? undefined : v));

describe('sampling with a scale', () => {
  it('puts every sampled pitch of every archetype on a note of the scale', () => {
    for (const a of loadArchetypes()) {
      for (const s of [scale, aMinor]) {
        for (const seed of [1, 2, 3, 4, 5, 6]) {
          for (const p of sampleArchetype(a, seed, 2, { scale: s })) expect(scaleSnapNotices(p, s), `${a.name} seed ${seed} ${s.root} ${s.mode}`).toEqual([]);
        }
      }
    }
  });

  it('leaves everything but the pitches exactly as it was drawn, and the pitches near where they were', () => {
    for (const name of ['coin', 'powerup', 'notification', 'fanfare', 'riser']) {
      const a = getArchetype(name);
      const plain = sampleArchetype(a, 9, 3), snapped = sampleArchetype(a, 9, 3, { scale });
      plain.forEach((p, i) => {
        expect(withoutPitches(snapped[i]), name).toBe(withoutPitches(p));
        pitchesOf(p).forEach((hz, k) => expect(Math.abs(1200 * Math.log2(pitchesOf(snapped[i])[k] / hz)), name).toBeLessThanOrEqual(600));
      });
    }
  });

  it('changes nothing without a scale, or with snapping off', () => {
    for (const a of loadArchetypes()) {
      const plain = JSON.stringify(sampleArchetype(a, 5, 2));
      expect(JSON.stringify(sampleArchetype(a, 5, 2, { scale: { ...scale, snap: false } })), a.name).toBe(plain);
      expect(JSON.stringify(sampleArchetype(a, 5, 2, {})), a.name).toBe(plain);
    }
  });

  it('is deterministic per seed', () => {
    const a = getArchetype('coin-bell');
    expect(JSON.stringify(sampleArchetype(a, 4, 3, { scale }))).toBe(JSON.stringify(sampleArchetype(a, 4, 3, { scale })));
  });
});

describe.skipIf(!(await chromiumAvailable()))('generate', () => {
  it('returns candidates that lint with no scale-snap notice', () => {
    const dir = project();
    const r = beeps(dir, 'generate', 'confirm', '--count', '3', '--seed', '4');
    expect(r.status).toBe(0);
    const names = r.out.candidates.map((c: { name: string }) => c.name);
    const lint = beeps(dir, 'lint', ...names).out.reports as { notices?: { code: string }[] }[];
    for (const rep of lint) expect((rep.notices ?? []).map(n => n.code)).not.toContain('N_SCALE_SNAP');
  });
});
