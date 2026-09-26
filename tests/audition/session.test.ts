import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, type OpenProject } from '../../src/project.ts';
import { writeSet, type CandidateSet } from '../../src/sets.ts';
import { appendEvent, foldSession, openSession, predictionStats, readEvents, readReveal, readSession, writePrediction } from '../../src/audition/session.ts';
import { readVerdicts } from '../../src/taste/verdicts.ts';
import type { Features } from '../../src/measure/index.ts';
import { coin } from '../helpers/patches.ts';

const feat = (centroid: number, energy: number): Features => ({
  durationSec: 0.3, samplePeakDb: -6, truePeakDb: -6, dcOffset: 0, clippedSamples: 0,
  momentaryMaxLufs: -18, shortTermMaxLufs: -20, integratedLufs: -20, integratedReliable: false,
  attackSec: 0.004, energyLengthSec: energy, tailSec: energy * 1.5, crestDb: 8,
  centroidHz: centroid, centroidPeakHz: centroid, flatness: 0.05, bands: [],
  sharpness: centroid / 1500, roughness: 0.02, fluctuation: 0.01,
  pitchHz: 1000, pitchStrength: 0.9, pitchDirection: 5, voicedFraction: 0.9,
  delivered: { samplePeakDb: -8, truePeakDb: -8, momentaryMaxLufs: -19, clippedSamples: 0 },
});

let p: OpenProject;
let set: CandidateSet;

beforeEach(() => {
  process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-home-'));
  p = initProject(mkdtempSync(join(tmpdir(), 'beeps-sess-')));
  set = writeSet(p, {
    id: 'coin-test-0001', archetype: 'coin', family: 'coin', prompt: 'coin for a cozy platformer', parent: null,
    createdAt: new Date().toISOString(), sheet: null,
    candidates: [1, 2, 3, 4].map(i => ({ index: i, name: `coin-1-${i}`, key: `k${i}`, seed: 1, trimDb: -3, features: feat(800 * i, 0.1 * i) as any, wav: '', look: '' })),
  }, [1, 2, 3, 4].map(i => ({ ...coin(), name: `coin-1-${i}` })));
});

describe('audition sessions', () => {
  it('refuses to open without a sealed agent prediction unless told not to', () => {
    expect(() => openSession(p, set.id, {})).toThrow(/prediction/);
    const s = openSession(p, set.id, { requirePrediction: false });
    expect(s.candidates).toHaveLength(4);
  });

  it('validates prediction indexes against the set', () => {
    expect(() => writePrediction(p, set.id, { pick: 9, shortlist: [], why: '' })).toThrow(/not in set/);
  });

  it('walks lineup → duel → refine → round → ship and records verdicts and the reveal', () => {
    writePrediction(p, set.id, { pick: 2, shortlist: [1, 2], why: 'warm and short' });
    const s = openSession(p, set.id, { prompt: 'coin' });
    const pred = JSON.parse(readFileSync(join(p.paths.sessions, s.id, 'prediction.json'), 'utf8'));
    expect(pred.agent.pick).toBe(2);
    expect(pred.model.pick).toBeNull(); // no judgements yet: no model pick

    let r = appendEvent(p, s.id, { type: 'play', index: 1, mode: 'single' });
    expect(r.verdicts).toBe(0); // plays are never verdicts
    r = appendEvent(p, s.id, { type: 'lineup', loved: [1, 2], duds: [4] });
    expect(r.verdicts).toBe(2); // two implied pairs at weight ⅓
    expect(r.state.stage).toBe('duel');
    expect(r.state.shortlist).toEqual([1, 2]);

    r = appendEvent(p, s.id, { type: 'duel', a: 1, b: 2, outcome: 'b', tags: ['less-harsh'], position: 'ba' });
    expect(r.state.stage).toBe('refine');
    expect(r.state.champion).toBe(2);

    r = appendEvent(p, s.id, { type: 'refine', champion: 2, directions: ['shorter'] });
    expect(r.state.stage).toBe('waiting');
    expect(r.state.pendingRefine).toMatchObject({ directions: ['shorter'], champion: 2 });

    const mutant = { ...s.candidates[1], index: 5, name: 'coin-m-5', round: 1 };
    r = appendEvent(p, s.id, { type: 'round', n: 1, setId: set.id, candidates: [mutant] });
    expect(r.state.stage).toBe('lineup');
    expect(r.state.lineup).toEqual([2, 5]);

    r = appendEvent(p, s.id, { type: 'lineup', loved: [5], duds: [] });
    expect(r.state.shortlist).toEqual([2, 5]); // champion pinned
    r = appendEvent(p, s.id, { type: 'duel', a: 2, b: 5, outcome: 'tie', tags: [] });
    expect(r.state.stage).toBe('refine');
    r = appendEvent(p, s.id, { type: 'ship', champion: 2, name: 'cozy-coin' });
    expect(r.state.stage).toBe('shipped');

    expect(() => appendEvent(p, s.id, { type: 'abandon' })).toThrow(/shipped/);
    const reveal = readReveal(p, s.id)!;
    expect(reveal.agent).toMatchObject({ pick: 2, hit: true, shortlistHit: true });

    const verdicts = readVerdicts(join(p.paths.taste, 'verdicts.jsonl')).rows;
    expect(verdicts.map(v => v.kind)).toEqual(['implied', 'implied', 'duel', 'tie']);
    expect(verdicts[2].winner!.name).toBe('coin-1-2');
    expect(readVerdicts(join(process.env.AGENT_BEEPS_HOME!, 'taste', 'verdicts.jsonl')).rows).toHaveLength(4);

    const stats = predictionStats();
    expect(stats).toMatchObject({ sessions: 1, agent: { predicted: 1, hits: 1, rate: 1 } });
    expect(foldSession(readSession(p, s.id), readEvents(p, s.id)).shipped).toBe(2);
    expect(existsSync(join(p.paths.patches, 'cozy-coin.json'))).toBe(true);
    expect(JSON.parse(readFileSync(p.paths.kit, 'utf8')).sounds).toEqual([{ name: 'cozy-coin', family: 'coin', priority: 3, trimDb: -3, seed: 1 }]);
  });

  it('turns both-bad into two half-weight losses against the family mean', () => {
    const s = openSession(p, set.id, { requirePrediction: false });
    appendEvent(p, s.id, { type: 'lineup', loved: [1, 3], duds: [] });
    const r = appendEvent(p, s.id, { type: 'duel', a: 1, b: 3, outcome: 'bothBad', tags: [] });
    expect(r.verdicts).toBe(2);
    const rows = readVerdicts(join(p.paths.taste, 'verdicts.jsonl')).rows;
    expect(rows.every(v => v.kind === 'bothBad' && v.weight === 0.5)).toBe(true);
  });

  it('rejects events about unknown candidates and malformed events', () => {
    const s = openSession(p, set.id, { requirePrediction: false });
    expect(() => appendEvent(p, s.id, { type: 'duel', a: 1, b: 42, outcome: 'a' })).toThrow(/not in session/);
    expect(() => appendEvent(p, s.id, { type: 'teleport' })).toThrow(/invalid event/);
    expect(() => readSession(p, '../../etc')).toThrow(/invalid session id/);
    expect(existsSync(join(p.paths.sessions, s.id, 'events.jsonl'))).toBe(true);
  });
});
