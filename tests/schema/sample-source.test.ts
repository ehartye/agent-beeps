import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePatch } from '../../src/schema/patch.ts';
import { initProject } from '../../src/project.ts';
import { resolveInstruments } from '../../src/music.ts';
import { buildSong } from '../../runtime/engine/song.js';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { song } from '../helpers/songs.ts';

const asset = `sha256:${'a'.repeat(64)}`;
const input = (source: unknown = { type: 'sample', asset }, extra: object = {}) => ({ schema: 'beeps/patch@1', name: 'sample', family: 'test', duration: 0.2, layers: [{ source, amp: {}, ...extra }] });
const scratch = mkdtempSync(join(tmpdir(), 'beeps-sample-schema-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('unpitched sample source', () => {
  it('accepts only the content ID and regular layer controls', () => {
    const r = parsePatch(input(undefined, { start: 0.03, pan: -0.2, gainDb: -6, filter: { type: 'lowpass', cutoff: 1000 }, lfo: { target: 'gain', rate: 2, depth: 0.1 } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.layers[0].source).toEqual({ type: 'sample', asset });
  });
  it.each(['a.wav', `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, 'https://x/a.wav'])('rejects non-content identity %s', id => expect(parsePatch(input({ type: 'sample', asset: id })).ok).toBe(false));
  it.each(['pitch', 'loop', 'playbackRate', 'url'])('rejects extra source property %s', key => expect(parsePatch(input({ type: 'sample', asset, [key]: 1 })).ok).toBe(false));
  it.each([{ pitchEnv: [] }, { pitchEnv: [{ at: 0, to: 440 }] }, { lfo: { target: 'pitch', rate: 1, depth: 2 } }])('explains unsupported sample pitch controls %j', extra => {
    const r = parsePatch(input(undefined, extra));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some(i => /sample.*unpitched|sample.*pitch/i.test(i.message))).toBe(true);
  });
  it('refuses song instruments before the browser graph creates any nodes', () => {
    const r = parsePatch(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = song();
    const ctx = new FakeContext();
    expect(() => buildSong(asCtx(ctx), s, { pad: r.patch, hat: r.patch })).toThrow(/sample.*instrument.*not supported/i);
    expect(ctx.created).toEqual([]);
  });
  it('refuses sample instruments during Node instrument resolution', () => {
    const p = initProject(scratch);
    const s = song({ instruments: { recording: input() }, tracks: { pad: { instrument: 'recording' }, hat: { instrument: 'hat' } } });
    expect(() => resolveInstruments(p, s)).toThrow(/sample.*instrument.*not supported/i);
  });
});
