import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { openProject, readJsonFile, type OpenProject } from '../project.ts';
import { libraryInstruments, listSongs, loadSong, resolveInstruments, saveSong, songOrThrow } from '../music.ts';
import { renderSong, type RenderedSong } from '../render/song-pipeline.ts';
import { lintSong } from '../song-lint.ts';
import { compileSong } from '../../runtime/engine/sequence.js';
import { int, withHost } from './shared.ts';
import type { Song } from '../schema/song.ts';

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** What the agent reads first about a rendered song; the full features are in meta.json. */
export function songSummary(r: RenderedSong, p: OpenProject) {
  const f = r.features;
  return {
    name: r.song.name, title: r.song.title ?? null, cached: r.cached, wav: r.wavPath, look: r.lookPath, meta: r.dir + '/meta.json',
    length: mmss(f.durationSec), durationSec: f.durationSec, loop: r.song.loop, trimDb: r.trimDb,
    features: {
      loudnessLufs: f.delivered?.integratedLufs, truePeakDb: f.delivered?.truePeakDb, loudnessRangeLu: f.loudnessRangeLu,
      centroidHz: f.centroidHz, lowShare: f.lowShare, stereoWidth: f.stereoWidth, ...(f.seamDb !== undefined ? { seamDb: f.seamDb } : {}),
    },
    sections: f.sections.map(s => ({ name: s.name, at: mmss(s.start), lufs: s.lufs, centroidHz: s.centroidHz })),
    lint: lintSong(r.song, f, p.project),
  };
}

/** Event counts per track and the section timeline, without rendering. */
function songOutline(song: Song) {
  const c = compileSong(song);
  const perTrack: Record<string, { notes: number; lowest: number | null; highest: number | null }> = {};
  for (const t of Object.keys(song.tracks)) perTrack[t] = { notes: 0, lowest: null, highest: null };
  for (const e of c.events) {
    const t = perTrack[e.track];
    t.notes++;
    if (e.midi !== null) { t.lowest = Math.min(t.lowest ?? 999, e.midi); t.highest = Math.max(t.highest ?? -1, e.midi); }
  }
  const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const nn = (m: number | null) => (m === null ? null : `${names[m % 12]}${Math.floor(m / 12) - 1}`);
  return {
    name: song.name, bpm: song.bpm, length: mmss(c.length), lengthSec: Math.round(c.length * 100) / 100, loop: song.loop,
    sections: c.sections.map(s => ({ name: s.name, at: mmss(s.start), bars: s.bars })),
    tracks: Object.fromEntries(Object.entries(perTrack).map(([k, v]) => [k, { notes: v.notes, range: v.lowest === null ? null : `${nn(v.lowest)}-${nn(v.highest)}` }])),
  };
}

export function registerSongCommands(program: Command, io: Io) {
  program.command('instruments')
    .description('list the bundled instrument patches songs can play by name')
    .action(() => io.emit({ instruments: libraryInstruments() }));

  const song = program.command('song').description('compose, render and export music (beeps/song@1)');

  song.command('new <file>')
    .description('validate a song JSON file and save it to .agent-beeps/songs/<name>.json')
    .option('--force', 'replace an existing song of the same name')
    .action((file: string, opts: { force?: boolean }) => {
      const p = openProject(io.projectDir());
      const s = songOrThrow(readJsonFile(file), file);
      resolveInstruments(p, s);
      io.emit({ saved: saveSong(p, s, { force: !!opts.force }), ...songOutline(s) });
    });

  song.command('list')
    .description('project songs and bundled library songs')
    .action(() => io.emit({ songs: listSongs(openProject(io.projectDir())) }));

  song.command('check <refs...>')
    .description('validate songs and print their outline (sections, notes and range per track) without rendering')
    .action((refs: string[]) => {
      const p = openProject(io.projectDir());
      io.emit({ songs: refs.map(r => { const s = loadSong(p, r); resolveInstruments(p, s); return songOutline(s); }) });
    });

  song.command('render <refs...>')
    .description('render, loudness-trim, measure and lint songs; writes a WAV and a look image per song')
    .option('--jobs <n>', 'songs rendered in parallel (one headless browser each)', int, 3)
    .action(async (refs: string[], opts: { jobs: number }) => {
      const p = openProject(io.projectDir());
      const songs = refs.map(r => loadSong(p, r));
      const instruments = songs.map(s => resolveInstruments(p, s));
      const out: RenderedSong[] = new Array(songs.length);
      let next = 0;
      const worker = () => withHost(async host => {
        while (next < songs.length) {
          const i = next++;
          out[i] = await renderSong(host, songs[i], instruments[i], { project: p.project, rendersDir: p.paths.renders });
        }
      });
      await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.jobs, songs.length)) }, worker));
      io.emit({ songs: out.map(r => songSummary(r, p)) });
    });

  song.command('lint <ref>')
    .description('render (or reuse) a song and check it against craft/music-rules.json')
    .action(async (ref: string) => {
      const p = openProject(io.projectDir());
      const s = loadSong(p, ref);
      const r = await withHost(host => renderSong(host, s, resolveInstruments(p, s), { project: p.project, rendersDir: p.paths.renders }));
      const report = lintSong(s, r.features, p.project);
      io.emit({ name: s.name, ...report });
      if (report.errors.length) process.exitCode = 1;
    });

  song.command('export <ref>')
    .description('write the loudness-trimmed WAV of a song')
    .requiredOption('--wav <path>', 'output WAV path')
    .action(async (ref: string, opts: { wav: string }) => {
      const p = openProject(io.projectDir());
      const s = loadSong(p, ref);
      const r = await withHost(host => renderSong(host, s, resolveInstruments(p, s), { project: p.project, rendersDir: p.paths.renders }));
      const dest = resolve(opts.wav);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(r.wavPath, dest);
      io.emit({ name: s.name, wav: dest, renderedWav: r.wavPath, loop: s.loop, durationSec: r.features.durationSec });
    });
}
