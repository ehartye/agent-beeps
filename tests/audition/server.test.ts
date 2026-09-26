import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, type OpenProject } from '../../src/project.ts';
import { writeSet } from '../../src/sets.ts';
import { openSession, writePrediction } from '../../src/audition/session.ts';
import { AuditionServer, type ServerInfo } from '../../src/audition/server.ts';
import { coin } from '../helpers/patches.ts';

const feat = (c: number) => ({ durationSec: 0.3, samplePeakDb: -6, truePeakDb: -6, dcOffset: 0, clippedSamples: 0, momentaryMaxLufs: -18, shortTermMaxLufs: -20, integratedLufs: -20, integratedReliable: false, attackSec: 0.004, energyLengthSec: 0.1 * c, tailSec: 0.2, crestDb: 8, centroidHz: 700 * c, centroidPeakHz: 700 * c, flatness: 0.05, bands: [], sharpness: c / 2, roughness: 0.02, fluctuation: 0.01, pitchHz: 1000, pitchStrength: 0.9, pitchDirection: 5, voicedFraction: 0.9, delivered: { samplePeakDb: -8, truePeakDb: -8, momentaryMaxLufs: -19, clippedSamples: 0 } });

let p: OpenProject, server: AuditionServer, info: ServerInfo, sessionId: string;
const refines: string[] = [];

beforeAll(async () => {
  process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-home-'));
  p = initProject(mkdtempSync(join(tmpdir(), 'beeps-srv-')));
  const lookDir = join(p.paths.renders, 'k1');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(lookDir, { recursive: true });
  writeFileSync(join(lookDir, 'look.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeSet(p, {
    id: 'coin-srv-0001', archetype: 'coin', family: 'coin', prompt: 'coin', parent: null, createdAt: new Date().toISOString(), sheet: null,
    candidates: [1, 2, 3].map(i => ({ index: i, name: `c-${i}`, key: `k${i}`, seed: 1, trimDb: -2, features: feat(i) as any, wav: '', look: join(lookDir, 'look.png') })),
  }, [1, 2, 3].map(i => ({ ...coin(), name: `c-${i}` })));
  writePrediction(p, 'coin-srv-0001', { pick: 1, shortlist: [1, 2], why: 'test' });
  sessionId = openSession(p, 'coin-srv-0001', { mode: 'handoff' }).id;
  server = new AuditionServer({ host: '127.0.0.1', port: 0, token: 'secret-token', projects: [p.paths.root], onRefine: async (_p, id) => { refines.push(id); } });
  info = await server.listen();
});
afterAll(async () => { await server?.close(); });

const api = (path: string, init: RequestInit = {}, token = 'secret-token') =>
  fetch(`http://127.0.0.1:${info.port}${path}${path.includes('?') ? '&' : '?'}t=${token}`, init);
const post = (body: unknown, token?: string) => api(`/api/session/${sessionId}/event`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, token);

describe('audition server', () => {
  it('reports health without a token and refuses the API without one', async () => {
    expect((await (await fetch(`http://127.0.0.1:${info.port}/api/health`)).json()).ok).toBe(true);
    expect((await api('/api/sessions', {}, 'wrong')).status).toBe(401);
    expect((await post({ type: 'play', index: 1, mode: 'single' }, 'nope')).status).toBe(401);
  });

  it('lists sessions and serves a session without any prediction', async () => {
    const list = await (await api('/api/sessions')).json();
    expect(list.sessions[0]).toMatchObject({ id: sessionId, stage: 'lineup' });
    const s = await (await api(`/api/session/${sessionId}`)).json();
    expect(s.candidates).toHaveLength(3);
    expect(s.candidates[0].patch.schema).toBe('beeps/patch@1');
    expect(s.candidates[2].words).toContain('bright');
    expect(JSON.stringify(s)).not.toMatch(/prediction|"why"/);
    expect((await api(`/api/session/${sessionId}/reveal`)).status).toBe(404);
  });

  it('serves pages and engine files but never escapes the runtime directory', async () => {
    expect((await fetch(`http://127.0.0.1:${info.port}/runtime/engine/patch.js`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${info.port}/runtime/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await api(`/api/session/..%2f..%2fx`)).status).toBe(404);
    const look = await api(`/api/session/${sessionId}/look/1`);
    expect(look.status).toBe(200);
  });

  it('validates events, suggests the next duel, triggers hand-off refinement and reveals after ship', async () => {
    expect((await post({ type: 'duel', a: 1, b: 99, outcome: 'a' })).status).toBe(400);
    expect((await post({ type: 'lineup', loved: [1, 2, 3], duds: [] })).status).toBe(200);
    const s = await (await api(`/api/session/${sessionId}`)).json();
    expect(s.state.stage).toBe('duel');
    expect(s.next).toHaveLength(2);
    await post({ type: 'refine', champion: 1, directions: ['darker'] });
    await new Promise(r => setTimeout(r, 50));
    expect(refines).toEqual([sessionId]);
    expect((await post({ type: 'ship', champion: 1 })).status).toBe(200);
    const reveal = await (await api(`/api/session/${sessionId}/reveal`)).json();
    expect(reveal.agent).toMatchObject({ pick: 1, hit: true });
    expect((await post({ type: 'abandon' })).status).toBe(409);
  });
});
