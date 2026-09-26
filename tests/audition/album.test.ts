import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, type OpenProject } from '../../src/project.ts';
import { appendAlbumEvent, foldAlbum, readAlbum, updateAlbumTrack, writeAlbum } from '../../src/album.ts';
import { AuditionServer, albumUrl, type ServerInfo } from '../../src/audition/server.ts';

let p: OpenProject, server: AuditionServer, info: ServerInfo, id: string;
const wav = Buffer.alloc(1000, 7);

beforeAll(async () => {
  process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-home-'));
  p = initProject(mkdtempSync(join(tmpdir(), 'beeps-album-')));
  const dir = join(p.paths.renders, 'song-abc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'delivered.wav'), wav);
  writeFileSync(join(dir, 'look.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const track = (n: number) => ({ name: `t${n}`, title: `Track ${n}`, description: 'd', loop: true, durationSec: 90, wav: join(dir, 'delivered.wav'), look: join(dir, 'look.png'), sections: [{ name: 'a', start: 0, end: 90 }], features: { loudnessLufs: -20 } });
  id = writeAlbum(p, { title: 'Sci-fi', tracks: [track(1), track(2)] }).id;
  server = new AuditionServer({ host: '127.0.0.1', port: 0, token: 'tok', projects: [p.paths.root] });
  info = await server.listen();
});
afterAll(async () => { await server?.close(); });

const api = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${info.port}${path}${path.includes('?') ? '&' : '?'}t=tok`, init);
const post = (body: unknown) => api(`/api/album/${id}/event`, { method: 'POST', body: JSON.stringify(body) });

describe('albums', () => {
  it('reads legacy ready tracks with a stable render identity', () => {
    const t = readAlbum(p, id).tracks[0];
    expect(t.status).toBe('ready');
    expect(t.renderKey).toBe('legacy:song-abc');
  });

  it('publishes pending tracks and preserves successful tracks beside failures', async () => {
    const a = writeAlbum(p, { title: 'In progress', tracks: [1, 2].map(n => ({ name: `pending-${n}`, title: `Pending ${n}`, loop: false, status: 'pending' })) });
    const pending = await (await api(`/api/album/${a.id}`)).json();
    expect(pending.tracks.map((t: any) => t.status)).toEqual(['pending', 'pending']);
    expect(pending.tracks[0].wav).toBeNull();
    expect((await api(`/api/album/${a.id}/wav/1`)).status).toBe(404);
    const ready = { ...readAlbum(p, id).tracks[0], renderKey: 'render-one' };
    updateAlbumTrack(p, a.id, 1, { ...ready, index: 1 });
    updateAlbumTrack(p, a.id, 2, { status: 'failed', error: 'instrument missing' });
    const done = readAlbum(p, a.id);
    expect(done.tracks.map(t => [t.index, t.name, t.status])).toEqual([[1, 'pending-1', 'ready'], [2, 'pending-2', 'failed']]);
    expect((await api(`/api/album/${a.id}/wav/1`)).status).toBe(200);
    expect((await api(`/api/album/${a.id}/look/2`)).status).toBe(404);
    expect(() => updateAlbumTrack(p, a.id, 1, { status: 'failed', error: 'late failure' })).toThrow(/settled/);
  });

  it('binds moment notes to a validated position, section and immutable render', async () => {
    const renderKey = readAlbum(p, id).tracks[0].renderKey;
    const event = { type: 'moment', index: 1, pos: 12.5, text: 'bell enters beautifully', renderKey };
    expect((await post(event)).status).toBe(200);
    const moments = foldAlbum(readAlbum(p, id), p).tracks[0].moments;
    expect(moments.at(-1)).toMatchObject({ pos: 12.5, text: event.text, section: 'a', renderKey });
    expect((await post({ ...event, renderKey: 'other-render' })).status).toBe(409);
    expect((await post({ ...event, pos: 91 })).status).toBe(400);
    expect((await post({ ...event, pos: -1 })).status).toBe(400);
    expect((await post({ ...event, section: 'invented' })).status).toBe(400);
    expect((await post({ ...event, text: '  ' })).status).toBe(400);
    const a = writeAlbum(p, { title: 'Waiting', tracks: [{ name: 'waiting', title: 'Waiting', loop: false, status: 'pending' }] });
    expect(() => appendAlbumEvent(p, a.id, { ...event, renderKey: 'pending' })).toThrow(/ready/);
  });

  it('folds marks, tags and notes, last write wins', () => {
    appendAlbumEvent(p, id, { type: 'mark', index: 1, mark: 'love' });
    appendAlbumEvent(p, id, { type: 'mark', index: 1, mark: 'keep' });
    appendAlbumEvent(p, id, { type: 'tags', index: 2, tags: ['too busy'] });
    appendAlbumEvent(p, id, { type: 'note', index: 2, text: 'lovely arp' });
    appendAlbumEvent(p, id, { type: 'note', text: 'more like track 2' });
    const s = foldAlbum(readAlbum(p, id), p);
    expect(s.tracks[0]).toMatchObject({ index: 1, mark: 'keep' });
    expect(s.tracks[1]).toMatchObject({ mark: null, tags: ['too busy'], note: 'lovely arp' });
    expect(s.note).toBe('more like track 2');
  });

  it('rejects bad events', () => {
    expect(() => appendAlbumEvent(p, id, { type: 'mark', index: 9, mark: 'love' })).toThrow(/track/);
    expect(() => appendAlbumEvent(p, id, { type: 'ship' })).toThrow();
  });

  it('serves the page, the album, wav ranges and looks behind the token', async () => {
    expect((await fetch(`http://127.0.0.1:${info.port}/a/${id}`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${info.port}/api/album/${id}`)).status).toBe(401);
    const a = await (await api(`/api/album/${id}`)).json();
    expect(a.tracks).toHaveLength(2);
    expect(a.tracks[0].wav).toMatch(/\/api\/album\/.+\/wav\/1$/);
    const full = await api(`/api/album/${id}/wav/1`);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect((await full.arrayBuffer()).byteLength).toBe(1000);
    const part = await api(`/api/album/${id}/wav/1`, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    expect((await api(`/api/album/${id}/look/2`)).status).toBe(200);
    expect((await api(`/api/albums`)).status).toBe(200);
  });

  it('records listener events and refuses unknown ones', async () => {
    expect((await post({ type: 'mark', index: 2, mark: 'love' })).status).toBe(200);
    expect((await post({ type: 'rm -rf' })).status).toBe(400);
    const a = await (await api(`/api/album/${id}`)).json();
    expect(a.state.tracks[1].mark).toBe('love');
  });

  it('builds LAN links, never localhost', () => {
    expect(albumUrl({ url: 'http://hal9000:47301', token: 'tok' }, id)).toBe(`http://hal9000:47301/a/${id}?t=tok`);
  });
});

import { rankAddresses } from '../../src/audition/server.ts';
describe('LAN addresses', () => {
  it('puts the physical LAN first, Tailscale after, and drops virtual adapters', () => {
    const ranked = rankAddresses({
      Tailscale: [{ family: 'IPv4', address: '100.121.49.34', internal: false }],
      'Local Area Connection* 12': [{ family: 'IPv4', address: '192.168.137.1', internal: false }],
      'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.93', internal: false }],
      'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      'vEthernet (WSL (Hyper-V firewall))': [{ family: 'IPv4', address: '172.22.112.1', internal: false }],
    } as any);
    expect(ranked.map(r => r.address)).toEqual(['192.168.1.93', '192.168.137.1', '100.121.49.34']);
    expect(ranked[2].label).toBe('tailscale');
  });
});
