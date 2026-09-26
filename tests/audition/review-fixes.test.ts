// Regression tests for the v1 code review: stage transitions, client-supplied paths, verdict hygiene, safe ship.
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, savePatch, type OpenProject } from '../../src/project.ts';
import { writeSet } from '../../src/sets.ts';
import { appendEvent, openSession, readEvents, readReveal, SessionCandidate, writePrediction } from '../../src/audition/session.ts';
import { AuditionServer } from '../../src/audition/server.ts';
import { readVerdicts } from '../../src/taste/verdicts.ts';
import { coin } from '../helpers/patches.ts';

const feat = (c: number) => ({ durationSec: 0.3, samplePeakDb: -6, truePeakDb: -6, dcOffset: 0, clippedSamples: 0, momentaryMaxLufs: -18, shortTermMaxLufs: -20, integratedLufs: -20, integratedReliable: false, attackSec: 0.004, energyLengthSec: 0.1 * c, tailSec: 0.2, crestDb: 8, centroidHz: 700 * c, centroidPeakHz: 700 * c, flatness: 0.05, bands: [], sharpness: c / 2, roughness: 0.02, fluctuation: 0.01, pitchHz: 1000, pitchStrength: 0.9, pitchDirection: 5, voicedFraction: 0.9, delivered: { samplePeakDb: -8, truePeakDb: -8, momentaryMaxLufs: -19, clippedSamples: 0 } });

let p: OpenProject;
let id: string;
const ev = (e: unknown) => appendEvent(p, id, e);
const verdicts = () => readVerdicts(join(p.paths.taste, 'verdicts.jsonl')).rows;

beforeEach(() => {
  process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-home-'));
  p = initProject(mkdtempSync(join(tmpdir(), 'beeps-rev-')));
  writeSet(p, {
    id: 'coin-rev-0001', archetype: 'coin', family: 'coin', prompt: 'coin', parent: null, createdAt: new Date().toISOString(), sheet: null,
    candidates: [1, 2, 3, 4].map(i => ({ index: i, name: `c-${i}`, key: `k${i}`, seed: 7, trimDb: -2, features: feat(i) as any, wav: '', look: '' })),
  }, [1, 2, 3, 4].map(i => ({ ...coin(), name: `c-${i}` })));
  writePrediction(p, 'coin-rev-0001', { pick: 2, shortlist: [2], why: '' });
  id = openSession(p, 'coin-rev-0001', {}).id;
});

describe('stage transitions', () => {
  it('rejects a second lineup, self-duels, off-shortlist duels, repeated pairs and early ship', () => {
    expect(() => ev({ type: 'ship', champion: 1 })).toThrow(/lineup/);
    ev({ type: 'lineup', loved: [1, 2, 3], duds: [] });
    expect(() => ev({ type: 'lineup', loved: [1], duds: [2] })).toThrow(/duel/);
    expect(() => ev({ type: 'duel', a: 1, b: 1, outcome: 'a' })).toThrow(/itself/);
    expect(() => ev({ type: 'duel', a: 1, b: 4, outcome: 'a' })).toThrow(/shortlist/);
    ev({ type: 'duel', a: 1, b: 2, outcome: 'a' });
    expect(() => ev({ type: 'duel', a: 2, b: 1, outcome: 'b' })).toThrow(/already/);
    expect(verdicts()).toHaveLength(1);
  });

  it('dedupes lineup marks and refuses a mark that is both keep and dud', () => {
    expect(() => ev({ type: 'lineup', loved: [2], duds: [2, 3] })).toThrow(/both/);
    ev({ type: 'lineup', loved: [2, 2], duds: [3, 3] });
    expect(verdicts()).toHaveLength(1);
  });

  it('refuses a lineup that keeps nothing, and lets the owner abandon instead', () => {
    expect(() => ev({ type: 'lineup', loved: [], duds: [1, 2, 3, 4] })).toThrow(/keep at least one/);
    expect(ev({ type: 'abandon' }).state.stage).toBe('abandoned');
  });

  it('accepts a round only while waiting, with fresh indexes, and recovers from a failed refine', () => {
    ev({ type: 'lineup', loved: [2], duds: [] });
    const cand = { index: 5, name: 'c-1', setId: 'coin-rev-0001', key: 'k', seed: 1, trimDb: 0, round: 1, raw: new Array(11).fill(0), features: {}, look: '' };
    expect(() => ev({ type: 'round', n: 1, setId: 'coin-rev-0001', candidates: [cand] })).toThrow(/waiting/);
    ev({ type: 'refine', champion: 2, directions: ['darker'] });
    expect(() => ev({ type: 'refine', champion: 2, directions: ['darker'] })).toThrow(/waiting/);
    expect(() => ev({ type: 'round', n: 1, setId: 'coin-rev-0001', candidates: [{ ...cand, index: 3 }] })).toThrow(/already/);
    const failed = ev({ type: 'refineFailed', message: 'no usable mutations' });
    expect(failed.state.stage).toBe('refine');
    expect(failed.state.lastError).toMatch(/no usable/);
  });
});

describe('client-supplied names and paths', () => {
  it('refuses candidate names and set ids that are not plain ids', () => {
    const bad = { index: 9, name: '..\\..\\sessions\\x\\prediction', setId: 'coin-rev-0001', key: 'k', seed: 1, trimDb: 0, round: 1, raw: [], features: {}, look: '' };
    expect(SessionCandidate.safeParse(bad).success).toBe(false);
    expect(SessionCandidate.safeParse({ ...bad, name: 'ok', setId: '../x' }).success).toBe(false);
  });

  it('accepts only owner events over HTTP', async () => {
    const server = new AuditionServer({ host: '127.0.0.1', port: 0, token: 'tok', projects: [p.paths.root] });
    const info = await server.listen();
    try {
      const post = (body: unknown) => fetch(`http://127.0.0.1:${info.port}/api/session/${id}/event?t=tok`, { method: 'POST', body: JSON.stringify(body) });
      const round = { type: 'round', n: 1, setId: 'coin-rev-0001', candidates: [{ index: 9, name: 'c-1', setId: 'coin-rev-0001', key: 'k', seed: 1, trimDb: 0, round: 1, raw: [], features: {}, look: '' }] };
      expect((await post(round)).status).toBe(403);
      expect((await post({ type: 'refineFailed', message: 'x' })).status).toBe(403);
      const list = await (await fetch(`http://127.0.0.1:${info.port}/api/sessions?t=tok`)).json();
      expect(JSON.stringify(list)).not.toContain(p.paths.root.replaceAll('\\', '\\\\'));
      expect((await fetch(`http://127.0.0.1:${info.port}/api/sessions?t=${'é'.repeat(3)}`)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${info.port}/runtime/%E0%A4%A`)).status).toBe(400);
      expect((await fetch(`http://127.0.0.1:${info.port}/runtime/engine`)).status).toBe(404);
    } finally { await server.close(); }
  });
});

describe('ship', () => {
  it('writes the patch and kit (with the auditioned seed) before recording, and refuses to clobber another patch', () => {
    savePatch(p, { ...coin(), name: 'jump', duration: 0.5 });
    ev({ type: 'lineup', loved: [2], duds: [] });
    const before = readEvents(p, id).length;
    expect(() => ev({ type: 'ship', champion: 2, name: 'jump' })).toThrow(/already exists/);
    expect(readEvents(p, id)).toHaveLength(before);
    ev({ type: 'ship', champion: 2, name: 'cozy-coin' });
    const kit = JSON.parse(readFileSync(p.paths.kit, 'utf8'));
    expect(kit.sounds[0]).toMatchObject({ name: 'cozy-coin', seed: 7, trimDb: -2 });
    expect(existsSync(join(p.paths.patches, 'cozy-coin.json'))).toBe(true);
  });

  it('records no model pick when the model had no data, and logs ties at half weight', () => {
    ev({ type: 'lineup', loved: [1, 2], duds: [] });
    ev({ type: 'duel', a: 1, b: 2, outcome: 'tie' });
    expect(verdicts()[0]).toMatchObject({ kind: 'tie', weight: 0.5 });
    ev({ type: 'ship', champion: 1 });
    expect(readReveal(p, id)!.model).toMatchObject({ pick: null, hit: false, verdicts: 0 });
  });
});

describe('event log', () => {
  it('repairs a torn last line before appending', () => {
    writeFileSync(join(p.paths.sessions, id, 'events.jsonl'), '{"type":"play","index":1,"mode":"1","at":"x","seq":1}\n{"type":"pl');
    ev({ type: 'play', index: 2, mode: '1' });
    const events = readEvents(p, id);
    expect(events.map(e => e.seq)).toEqual([1, 2]);
  });
});
