import { expect, it } from 'vitest';
import { createPlayer } from '../../runtime/player/player.js';
import { asCtx, FakeContext } from '../helpers/fake-context.ts';

async function setup(lazy = false, fetcher?: (url: string) => Promise<void>) {
  const ctx = new FakeContext();
  ctx.decodeAudioData = async () => ctx.createBuffer(2, 192000, 48000);
  const assets = {
    score: { file: 'mix.wav', loop: true, durationSec: 4, bpm: 120, layers: [{ name: 'bed', file: 'bed.wav' }, { name: 'pulse', file: 'pulse.wav' }], states: { full: ['bed', 'pulse'], calm: ['bed'] }, initialState: 'full' },
    other: { file: 'other.wav', loop: true, durationSec: 4 },
    once: { file: 'once.wav', loop: false, durationSec: 4 },
  };
  const player = createPlayer({ context: asCtx(ctx) as AudioContext, catalog: { assets }, layerLoading: lazy ? 'state' : 'all', fetcher: async url => { await fetcher?.(url); return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(8) }; } });
  await player.unlock(); await player.music('score', { fadeSec: 0 });
  ctx.currentTime = 0.63;
  return { ctx, player };
}

it('holds music position without suspending its caller-owned context', async () => {
  const ctx = new FakeContext();
  const player = createPlayer({ context: asCtx(ctx) as AudioContext, catalog: { assets: { theme: { file: 'theme.wav', loop: true } } }, fetcher: async () => ({ ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(8) }) });
  await player.unlock(); await player.music('theme', { fadeSec: 0 });
  ctx.currentTime = 0.08;
  const before = player.inspect().music?.positionSec;
  expect(player.pauseMusic()).toBe(true);
  ctx.currentTime = 3;
  expect(player.inspect().music).toMatchObject({ paused: true, positionSec: before });
  expect(ctx.state).toBe('running');
  expect(player.resumeMusic()).toBe(true);
  const last = ctx.nodes('bufferSource').at(-1)!;
  expect(last.offset).toBeCloseTo(before!);
  expect(last.startedAt).toBeCloseTo(3.05);
  player.dispose();
});

it('retires outgoing crossfades and lazy-layer tails while retaining only the paused bed holds', async () => {
  const { ctx, player } = await setup(true);
  player.setState('calm', { fadeSec: 3 }); // pulse leaves the layer map before its scheduled stop
  const tails = ctx.nodes('bufferSource');
  expect(player.pauseMusic()).toBe(true);
  expect(tails.every(n => n.stoppedAt === 0)).toBe(true);
  expect(player.memory().pinnedBuffers).toBe(1);
  player.resumeMusic(); await player.music('other', { fadeSec: 3 });
  player.pauseMusic();
  expect(ctx.nodes('bufferSource').every(n => n.stoppedAt === 0)).toBe(true);
  expect(player.memory().pinnedBuffers).toBe(1);
  player.dispose(); expect(player.memory().pinnedBuffers).toBe(0);
});

it('repeated holds preserve aligned offsets and tolerate old ended callbacks', async () => {
  const { ctx, player } = await setup();
  for (let i = 0; i < 5; i++) {
    const expected = player.inspect().music!.positionSec!;
    player.pauseMusic(); player.pauseMusic();
    expect(ctx.nodes('bufferSource').every(n => n.onended === null || n.stoppedAt === undefined)).toBe(true);
    ctx.currentTime += 1;
    expect(player.inspect().music!.positionSec).toBeCloseTo(expected);
    expect(player.resumeMusic()).toBe(true);
    const latest = ctx.nodes('bufferSource').slice(-2);
    expect(latest[0].startedAt).toBe(latest[1].startedAt);
    expect(latest.map(n => n.offset)).toEqual([expected, expected]);
    expect(player.inspect().music!.positionSec).toBeCloseTo(expected);
    ctx.currentTime += 0.2;
  }
  player.dispose(); expect(player.memory().pinnedBuffers).toBe(0);
});

it('keeps pause retryable after a partial resume failure and never suspends another owner', async () => {
  const { ctx, player } = await setup(); player.pauseMusic();
  const make = ctx.createBufferSource.bind(ctx); let count = 0;
  ctx.createBufferSource = () => { const n = make(); if (++count === 2) n.start = () => { throw Error('start failure'); }; return n; };
  expect(player.resumeMusic()).toBe(false);
  expect(player.inspect().music?.paused).toBe(true); expect(player.memory().pinnedBuffers).toBe(2);
  expect(ctx.nodes('bufferSource').every(n => n.stoppedAt === 0)).toBe(true);
  ctx.createBufferSource = make;
  ctx.state = 'suspended'; expect(player.resumeMusic()).toBe(false);
  ctx.state = 'running'; expect(player.resumeMusic()).toBe(true);
  expect(ctx.state).toBe('running'); player.dispose();
});

it.each(['null', 'replacement', 'stopAll', 'disable', 'dispose'])('releases paused ownership on %s', async action => {
  const { player } = await setup(); player.pauseMusic();
  if (action === 'null') await player.music(null);
  if (action === 'replacement') await player.music('other', { fadeSec: 0 });
  if (action === 'stopAll') player.stopAll();
  if (action === 'disable') player.setEnabled(false);
  if (action === 'dispose') player.dispose();
  expect(player.memory().pinnedBuffers).toBe(action === 'replacement' ? 1 : 0);
  player.dispose();
});

it('starts a scheduled paused bed at zero and clamps non-looping end position', async () => {
  const { ctx, player } = await setup();
  await player.music('once', { at: 'bar', fadeSec: 0 });
  expect(player.inspect().music!.positionSec).toBe(0);
  player.pauseMusic(); ctx.currentTime += 3; player.resumeMusic();
  expect(ctx.nodes('bufferSource').at(-1)!.offset).toBe(0);
  ctx.currentTime += 8;
  expect(player.inspect().music!.positionSec).toBe(4);
  player.pauseMusic(); expect(player.resumeMusic()).toBe(false);
  expect(player.memory().pinnedBuffers).toBe(0); player.dispose();
});

it('updates states while paused without starting sources, and asking for the same id stays paused', async () => {
  const { ctx, player } = await setup(); player.pauseMusic();
  const count = ctx.nodes('bufferSource').length;
  player.setState('calm'); await player.music('score', { gainDb: -6 });
  expect(ctx.nodes('bufferSource')).toHaveLength(count);
  expect(player.inspect().music?.paused).toBe(true);
  player.resumeMusic(); expect(player.inspect().music!.layers).toEqual({ bed: 1, pulse: 0 });
  player.dispose();
});

it('owns only a terminal analyser edge and rejects stale detaches and wrong contexts', async () => {
  const { ctx, player } = await setup();
  const analyser = ctx.createAnalyser(), other = ctx.createGain(); other.connect(analyser);
  const node = analyser as unknown as AnalyserNode;
  const detach = player.attachOutputAnalyser(node)!;
  expect(player.attachOutputAnalyser(node)).toBe(detach);
  const output = ctx.nodes('shaper')[0]; expect(output.outputs).toEqual([ctx.destination, analyser]);
  detach(); const latest = player.attachOutputAnalyser(node)!; detach();
  expect(output.outputs).toContain(analyser);
  expect(player.attachOutputAnalyser(new FakeContext().createAnalyser() as unknown as AnalyserNode)).toBeNull();
  expect(player.attachOutputAnalyser(ctx.destination as unknown as AnalyserNode)).toBeNull();
  player.dispose(); latest();
  expect(output.outputs).not.toContain(analyser);
  expect(other.outputs).toContain(analyser); expect(analyser.disconnected).not.toBe(true);
});

it('cancels music queued before unlock', async () => {
  const ctx = new FakeContext();
  const player = createPlayer({ context: asCtx(ctx) as AudioContext, catalog: { assets: { score: { file: 'score.wav' } } }, fetcher: async () => ({ ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(8) }) });
  await player.music('score'); expect(player.pauseMusic()).toBe(false);
  await player.unlock(); expect(ctx.nodes('bufferSource')).toHaveLength(0);
  expect(player.inspect().music).toBeNull(); player.dispose();
});

it('rejects stale lazy completion after pause/resume', async () => {
  let release!: () => void, gate = false;
  const { ctx, player } = await setup(true, async url => { if (gate && url.endsWith('pulse.wav')) await new Promise<void>(r => { release = r; }); });
  player.setState('calm', { fadeSec: 0 });
  const pulse = ctx.nodes('bufferSource')[1]; pulse.onended();
  player.unload('score'); gate = true;
  player.setState('full', { fadeSec: 0 });
  await new Promise(r => setTimeout(r, 0));
  player.pauseMusic(); ctx.currentTime += 1; player.resumeMusic();
  release(); await new Promise(r => setTimeout(r, 0));
  // One resumed bed plus one newly wanted pulse, never a source from the stale generation.
  expect(ctx.nodes('bufferSource').filter(n => n.stoppedAt === undefined)).toHaveLength(2);
  player.dispose(); expect(player.memory().pinnedBuffers).toBe(0);
});

it('cancels a replacement in flight and releases paused music even while hidden', async () => {
  let release!: () => void;
  const { ctx, player } = await setup(false, async url => { if (url.endsWith('other.wav')) await new Promise<void>(r => { release = r; }); });
  const replacement = player.music('other'); await new Promise(r => setTimeout(r, 0));
  player.pauseMusic(); release(); expect(await replacement).toBe(false);
  expect(player.inspect().music).toMatchObject({ id: 'score', paused: true });
  player.setHidden(true); await new Promise(r => setTimeout(r, 0));
  expect(player.resumeMusic()).toBe(false); expect(ctx.state).toBe('suspended');
  await player.music(null); expect(player.memory().pinnedBuffers).toBe(0);
  player.dispose();
});
