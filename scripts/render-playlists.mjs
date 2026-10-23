// Render the three playlists (playlists/songs/<set>/*.json) to the mp3s, look images and tracks.json the playlist page plays.
// Explicit authoring step, like render-showcase: ordinary site builds only copy these committed results.
//   node scripts/render-playlists.mjs [--set hosting|focus|pump] [--only song-name,...]
// Each set is rendered against its own loudness target (playlists/sets.json), and songs resolve instruments from the
// library only, so a developer's same-named local patch cannot change a published render.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ffmpegStatic from 'ffmpeg-static';
import { openRenderHost } from '../src/render/host.ts';
import { initProject } from '../src/project.ts';
import { parseProject } from '../src/schema/project.ts';
import { renderSong } from '../src/render/song-pipeline.ts';
import { loadSong, resolveInstruments } from '../src/music.ts';
import { lintSong } from '../src/song-lint.ts';
import { readWav } from '../src/audio/wav.ts';
import { integrated, truePeakDb } from '../src/measure/loudness.ts';

const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, 'playlists');
const media = resolve(dir, 'media');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const onlySet = arg('set'), onlyNames = arg('only')?.split(',');
// VBR quality for the mp3s. About 100 to 130 kbps for music at 48 kHz: transparent enough for background listening, small enough to host.
const QUALITY = '5';

// --seal: hash every published file into playlists/manifest.json, which the site build verifies. Rendering does not touch it, so an
// edited score or a re-rendered mp3 fails the build until it is sealed on purpose.
if (process.argv.includes('--seal')) {
  const files = {};
  const walk = (d, rel) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = rel + '/' + e.name; if (e.isDirectory()) walk(resolve(d, e.name), r); else files[r.slice(1)] = createHash('sha256').update(readFileSync(resolve(d, e.name))).digest('hex'); } };
  for (const sub of ['media', 'songs']) walk(resolve(dir, sub), '/playlists/' + sub);
  files['playlists/tracks.json'] = createHash('sha256').update(readFileSync(resolve(dir, 'tracks.json'))).digest('hex');
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1));
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify({ schema: 'beeps/playlists-manifest@1', files: sorted }, null, 2) + '\n');
  console.log('sealed ' + Object.keys(sorted).length + ' files');
  process.exit(0);
}

const sets = JSON.parse(readFileSync(resolve(dir, 'sets.json'), 'utf8'));
mkdirSync(media, { recursive: true });
// A fixed scratch project, so a second run finds the first run's renders in its cache instead of starting over.
const scratch = initProject(resolve(tmpdir(), 'beeps-playlists-cache'));
const libraryOnly = { ...scratch, paths: { ...scratch.paths, patches: resolve(scratch.paths.dir, 'library-only') } };
if (existsSync(libraryOnly.paths.patches)) throw new Error('the library-only patches folder must not exist');

const ffmpeg = process.env.BEEPS_FFMPEG || ffmpegStatic;
const run = args => {
  const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'ffmpeg failed; run npm install to install ffmpeg-static or set BEEPS_FFMPEG');
};

const host = await openRenderHost();
const readSession = () => existsSync(resolve(dir, 'tracks.json')) ? JSON.parse(readFileSync(resolve(dir, 'tracks.json'), 'utf8')) : { schema: 'beeps/playlists@1', sets: [] };
const session = readSession();
// Written after every track, re-reading the file first, so a stopped run keeps what it finished and runs of different sets keep each other's results.
function save(set, tracks) {
  const merged = readSession();
  const entry = { id: set.id, title: set.title, tagline: set.tagline, brief: set.brief, sources: set.sources, tracks: [...tracks] };
  const at = merged.sets.findIndex(s => s.id === set.id);
  if (at >= 0) merged.sets[at] = entry; else merged.sets.push(entry);
  merged.sets.sort((a, b) => sets.findIndex(s => s.id === a.id) - sets.findIndex(s => s.id === b.id));
  writeFileSync(resolve(dir, 'tracks.json'), JSON.stringify(merged, null, 2) + '\n');
}
try {
  for (const set of sets) {
    if (onlySet && set.id !== onlySet) continue;
    const project = parseProject({ schema: 'beeps/project@1', scale: { root: 'C', mode: 'major', snap: false }, targetLoudness: -18, musicLoudness: set.musicLoudness, sampleRate: 48000 });
    const opts = { project, rendersDir: scratch.paths.renders };
    const files = readdirSync(resolve(dir, 'songs', set.id)).filter(f => f.endsWith('.json'));
    const order = set.order ?? files.map(f => f.replace(/\.json$/, ''));
    const tracks = [];
    for (const id of order) {
      const prior = session.sets.find(s => s.id === set.id)?.tracks.find(t => t.id === id);
      if (onlyNames && !onlyNames.includes(id)) { if (prior) tracks.push(prior); continue; }
      const path = resolve(dir, 'songs', set.id, `${id}.json`);
      const song = loadSong(libraryOnly, path), instruments = resolveInstruments(libraryOnly, song);
      const render = await renderSong(host, song, instruments, opts);
      const lint = lintSong(song, render.features, project, instruments);
      if (lint.errors.length) throw new Error(`${id}: ${JSON.stringify(lint.errors)}`);
      copyFileSync(render.lookPath, resolve(media, `${id}.png`));
      const encoded = resolve(media, `${id}.mp3`), decoded = resolve(scratch.paths.dir, `${id}-decoded.wav`);
      run(['-i', render.wavPath, '-c:a', 'libmp3lame', '-q:a', QUALITY, '-ar', '48000', '-write_xing', '1', encoded]);
      run(['-i', encoded, '-c:a', 'pcm_f32le', decoded]);
      const wav = readWav(readFileSync(decoded));
      const lufs = integrated(wav.channels, wav.sampleRate).lufs, peak = truePeakDb(wav.channels, wav.sampleRate), durationSec = wav.channels[0].length / wav.sampleRate;
      if (!Number.isFinite(peak) || peak > -1) throw new Error(`${id}: encoded peak ${peak} dBTP is not finite or exceeds -1 dBTP`);
      tracks.push({
        id, title: song.title, description: song.description, tags: song.tags ?? [], bpm: song.bpm, durationSec: Math.round(durationSec * 10) / 10,
        loudnessLufs: Math.round(lufs * 10) / 10, targetLufs: set.musicLoudness, truePeakDb: Math.round(peak * 10) / 10, loop: song.loop,
        mp3: `./media/${id}.mp3`, look: `./media/${id}.png`, recipe: `./songs/${set.id}/${id}.json`,
        lint: { warnings: lint.warnings.map(w => ({ rule: w.rule, message: w.message.slice(0, 200) })) },
      });
      console.log(`${set.id}/${id}: ${durationSec.toFixed(1)} s, ${lufs.toFixed(1)} LUFS (target ${set.musicLoudness}), ${peak.toFixed(1)} dBTP, ${lint.warnings.length} lint warnings`);
      save(set, tracks);
    }
    save(set, tracks);
  }
} finally {
  await host.close();
}
