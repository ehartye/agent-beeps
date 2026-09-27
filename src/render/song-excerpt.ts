// Preview the delivered mix, without recompiling its arrangement or changing its level.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BeepsError } from '../errors.ts';
import { readWav } from '../audio/wav.ts';
import { renderKey } from '../hash.ts';
import { measureSong, type SongSection } from '../measure/song.ts';
import { clippedSamples } from '../measure/envelope.ts';
import type { RenderHost } from './host.ts';
import type { RenderedSong } from './song-pipeline.ts';

/** Internal delivered WAVs have the canonical 44-byte PCM header written by writeWav. */
export function excerptWav(wav: Buffer, timeline: SongSection[], names: string[]) {
  if (!names.length) throw new BeepsError('E_USAGE', 'select at least one section');
  for (const name of names) if (!timeline.some(s => s.name === name)) {
    throw new BeepsError('E_USAGE', `no played section "${name}"`, { hint: `sections: ${[...new Set(timeline.map(s => s.name))].join(', ')}` });
  }
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.toString('ascii', 36, 40) !== 'data') {
    throw new BeepsError('E_RENDER', 'expected a delivered PCM WAV');
  }
  const sr = wav.readUInt32LE(24), frameSize = wav.readUInt16LE(32);
  const frames = wav.readUInt32LE(40) / frameSize;
  const sourceRanges = timeline.filter(s => names.includes(s.name)).map(({ name, start, end }) => ({ name, start, end }));
  let offset = 0;
  const sections: SongSection[] = [];
  const chunks = sourceRanges.map(s => {
    const from = Math.round(s.start * sr), to = Math.min(frames, Math.round(s.end * sr));
    if (from < 0 || to <= from || to > frames) throw new BeepsError('E_RENDER', 'section is outside the delivered WAV');
    const length = to - from;
    sections.push({ name: s.name, start: offset / sr, end: (offset + length) / sr });
    offset += length;
    return wav.subarray(44 + from * frameSize, 44 + to * frameSize);
  });
  const header = Buffer.from(wav.subarray(0, 44));
  header.writeUInt32LE(36 + offset * frameSize, 4);
  header.writeUInt32LE(offset * frameSize, 40);
  return { wav: Buffer.concat([header, ...chunks]), sections, sourceRanges };
}

export async function renderSongExcerpt(host: RenderHost, full: RenderedSong, names: string[]): Promise<RenderedSong> {
  const spans = full.features.sections;
  // Validate before trusting a cached selection, and preserve repeated occurrences in form order.
  for (const name of names) if (!spans.some(s => s.name === name)) throw new BeepsError('E_USAGE', `no played section "${name}"`);
  if (!names.length) throw new BeepsError('E_USAGE', 'select at least one section');
  const sourceRanges = spans.filter(s => names.includes(s.name)).map(({ name, start, end }) => ({ name, start, end }));
  const key = renderKey({ sourceKey: full.key, sourceRanges }, { kind: 'song-excerpt', version: 1 });
  const dir = join(dirname(full.dir), `song-${key.slice(0, 40)}`);
  const wavPath = join(dir, 'delivered.wav'), lookPath = join(dir, 'look.png'), metaPath = join(dir, 'meta.json');
  const song = { ...full.song, loop: false, form: sourceRanges.map(s => s.name) };
  const excerpt = { sourceKey: full.key, sourceRanges };
  if (existsSync(metaPath) && existsSync(wavPath) && existsSync(lookPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    return { key, song, trimDb: full.trimDb, features: meta.features, dir, wavPath, lookPath, cached: true, excerpt };
  }
  const cut = excerptWav(readFileSync(full.wavPath), spans, names);
  const { channels, sampleRate } = readWav(cut.wav);
  const features = measureSong(channels, sampleRate, cut.sections);
  features.delivered = { integratedLufs: features.integratedLufs, truePeakDb: features.truePeakDb, clippedSamples: clippedSamples(channels) };
  const look = await host.songPcmLook(channels, features, `${song.title ?? song.name} — excerpt`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(wavPath, cut.wav);
  writeFileSync(lookPath, look);
  writeFileSync(join(dir, 'song.json'), JSON.stringify(song, null, 2));
  writeFileSync(metaPath, JSON.stringify({ songName: song.name, trimDb: full.trimDb, features, excerpt }, null, 2));
  return { key, song, trimDb: full.trimDb, features, dir, wavPath, lookPath, cached: false, excerpt };
}
