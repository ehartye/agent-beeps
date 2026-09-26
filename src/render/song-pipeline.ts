// Song render → measure → integrated-loudness trim → clip → cache WAV, features and look image.
// One render pass: the trim and clipper are applied in Node with the engine's own clipper curve.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderKey } from '../hash.ts';
import { writeWav } from '../audio/wav.ts';
import { applyTrimAndClip, measureSong, type SongFeatures } from '../measure/song.ts';
import { integrated, truePeakDb } from '../measure/loudness.ts';
import { clippedSamples } from '../measure/envelope.ts';
import type { Patch } from '../schema/patch.ts';
import type { Song } from '../schema/song.ts';
import type { Project } from '../schema/project.ts';
import type { RenderHost } from './host.ts';
import { PEAK_CEILING_DB } from './pipeline.ts';

/** Bump when song rendering or measurement changes, so cached renders are redone. */
export const SONG_PIPELINE_VERSION = 2;

export interface RenderedSong {
  key: string; song: Song; trimDb: number; features: SongFeatures;
  dir: string; wavPath: string; lookPath: string; cached: boolean;
}

/** `trimDb` fixes the trim instead of levelling to the target: stems play at their full mix's trim. */
export async function renderSong(host: RenderHost, song: Song, instruments: Record<string, Patch>, { project, rendersDir, trimDb: fixedTrim }: { project: Project; rendersDir: string; trimDb?: number }): Promise<RenderedSong> {
  const target = project.musicLoudness;
  const key = renderKey({ song, instruments }, { kind: 'song', target, pipeline: SONG_PIPELINE_VERSION, ...(fixedTrim !== undefined ? { fixedTrim } : {}) });
  const dir = join(rendersDir, `song-${key.slice(0, 40)}`);
  const wavPath = join(dir, 'delivered.wav'), lookPath = join(dir, 'look.png'), meta = join(dir, 'meta.json');
  if (existsSync(meta) && existsSync(wavPath) && existsSync(lookPath)) {
    const m = JSON.parse(readFileSync(meta, 'utf8'));
    return { key, song, trimDb: m.trimDb, features: m.features, dir, wavPath, lookPath, cached: true };
  }
  const r = await host.renderSong(song, instruments);
  try {
    const authored = await host.pullSong(r.id, r.frames);
    const f = measureSong(authored, r.sampleRate, r.sections, { loop: song.loop });
    if (fixedTrim === undefined && !(f.integratedLufs > -70)) throw new Error(`song rendered near-silence (${f.integratedLufs} LUFS)`);
    const loud = target - f.integratedLufs;
    const ceiling = PEAK_CEILING_DB - f.truePeakDb;
    const trimDb = fixedTrim ?? Math.round(Math.max(-36, Math.min(24, Math.min(loud, ceiling))) * 100) / 100;
    const delivered = applyTrimAndClip(authored, trimDb);
    // Report the arc and sections at the level they play, like every other number the agent reads.
    f.arc = f.arc.map(v => Math.round((v + trimDb) * 10) / 10);
    f.sections = f.sections.map(s => ({ ...s, lufs: Math.round((s.lufs + trimDb) * 10) / 10 }));
    f.delivered = {
      integratedLufs: Math.round(integrated(delivered, r.sampleRate).lufs * 100) / 100,
      truePeakDb: Math.round(truePeakDb(delivered, r.sampleRate) * 100) / 100,
      clippedSamples: clippedSamples(delivered),
      ...(fixedTrim === undefined && ceiling < loud ? { peakLimited: true } : {}),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(wavPath, writeWav(delivered, r.sampleRate));
    writeFileSync(join(dir, 'song.json'), JSON.stringify(song, null, 2));
    writeFileSync(lookPath, await host.songLook(r.id, f, song.title ?? song.name));
    writeFileSync(meta, JSON.stringify({ songName: song.name, trimDb, features: f }, null, 2));
    return { key, song, trimDb, features: f, dir, wavPath, lookPath, cached: false };
  } finally {
    await host.freeSong(r.id);
  }
}
