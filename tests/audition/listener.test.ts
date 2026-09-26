// Acceptance: a simulated owner with a hidden taste drives auditions through the HTTP API; the
// taste model's sealed predictions should beat chance once it has learned from earlier sessions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mulberry32 } from '../../runtime/engine/rng.js';
import { initProject, type OpenProject } from '../../src/project.ts';
import { writeSet } from '../../src/sets.ts';
import { openSession, predictionStats } from '../../src/audition/session.ts';
import { AuditionServer, type ServerInfo } from '../../src/audition/server.ts';
import { coin } from '../helpers/patches.ts';

const SESSIONS = 14, COUNT = 6;
let p: OpenProject, server: AuditionServer, info: ServerInfo;

beforeAll(async () => {
  process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-home-'));
  p = initProject(mkdtempSync(join(tmpdir(), 'beeps-listener-')));
  server = new AuditionServer({ host: '127.0.0.1', port: 0, token: 't0k', projects: [p.paths.root] });
  info = await server.listen();
});
afterAll(async () => { await server?.close(); });

const api = async (path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${info.port}${path}?t=t0k`, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {});
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

describe('simulated listener', () => {
  it('teaches the taste model to predict the owner better than chance', async () => {
    const rand = mulberry32(42);
    // Hidden taste: darker and shorter, dislikes sharpness. Noise keeps it human.
    const utilityOf = (f: any) => -1.4 * Math.log2(f.centroidHz / 1000) - 2 * Math.log10(f.energyLengthSec) - 0.8 * f.sharpness + (rand() - 0.5) * 0.6;
    const hits: boolean[] = [];
    for (let s = 0; s < SESSIONS; s++) {
      const cands = Array.from({ length: COUNT }, (_, i) => {
        const centroid = 500 * 2 ** (rand() * 3), energy = 0.05 * 2 ** (rand() * 3);
        const features = { durationSec: 0.4, samplePeakDb: -6, truePeakDb: -6, dcOffset: 0, clippedSamples: 0, momentaryMaxLufs: -18, shortTermMaxLufs: -20, integratedLufs: -20, integratedReliable: false,
          attackSec: 0.003 + rand() * 0.01, energyLengthSec: energy, tailSec: energy * 1.5, crestDb: 6 + rand() * 6, centroidHz: centroid, centroidPeakHz: centroid, flatness: rand() * 0.1, bands: [],
          sharpness: 0.6 + Math.log2(centroid / 500) * 0.5 + rand() * 0.2, roughness: rand() * 0.05, fluctuation: rand() * 0.05, pitchHz: 800, pitchStrength: 0.9, pitchDirection: rand() * 10, voicedFraction: 0.9,
          delivered: { samplePeakDb: -8, truePeakDb: -8, momentaryMaxLufs: -19, clippedSamples: 0 } };
        return { index: i + 1, name: `c${s}-${i + 1}`, key: `k${s}${i}`, seed: 1, trimDb: 0, features, wav: '', look: '' };
      });
      const setId = `coin-sim-${String(s).padStart(4, '0')}`;
      writeSet(p, { id: setId, archetype: 'coin', family: 'coin', prompt: 'sim', parent: null, createdAt: new Date(Date.now() + s).toISOString(), sheet: null, candidates: cands as any },
        cands.map(c => ({ ...coin(), name: c.name })));
      const session = openSession(p, setId, { requirePrediction: false });
      const u = new Map(cands.map(c => [c.index, utilityOf(c.features)]));
      const ranked = [...u.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
      await api(`/api/session/${session.id}/event`, { type: 'lineup', loved: ranked.slice(0, 3), duds: ranked.slice(-2) });
      for (let guard = 0; guard < 10; guard++) {
        const st = await api(`/api/session/${session.id}`);
        if (!st.next.length) break;
        const [a, b] = st.next;
        await api(`/api/session/${session.id}/event`, { type: 'duel', a, b, outcome: u.get(a)! > u.get(b)! ? 'a' : 'b', tags: [] });
      }
      const st = await api(`/api/session/${session.id}`);
      await api(`/api/session/${session.id}/event`, { type: 'ship', champion: st.state.champion });
      const reveal = await api(`/api/session/${session.id}/reveal`);
      hits.push(reveal.model.hit);
    }
    const late = hits.slice(SESSIONS / 2);
    if (process.env.BEEPS_REPORT) console.log(JSON.stringify({ early: hits.slice(0, SESSIONS / 2).filter(Boolean).length, late: late.filter(Boolean).length, of: late.length }));
    const lateRate = late.filter(Boolean).length / late.length;
    expect(lateRate).toBeGreaterThan(2 / COUNT); // chance is 1/6
    expect(predictionStats({ project: p.paths.root }).sessions).toBe(SESSIONS);
    const taste = await import('../../src/taste/summary.ts');
    const { loadModel } = await import('../../src/audition/session.ts');
    const summary = taste.summarize(loadModel(p), 0);
    expect(summary.preferences.slice(0, 3).map(x => x.words).join(' ')).toMatch(/darker|shorter|less sharp/);
  });
});
