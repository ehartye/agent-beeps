import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { BeepsError } from '../errors.ts';
import { listPatches, openProject, readJsonFile, type OpenProject } from '../project.ts';
import { findInstrument, libraryInstruments, listSongs, midiName, shadowedInstruments, soloSong, loadSong, resolveInstruments, saveSong, songOrThrow } from '../music.ts';
import { notice, noticeField } from '../notices.ts';
import { songNotices } from '../song-notices.ts';
import { readFileSync } from 'node:fs';
import { readWav } from '../audio/wav.ts';
import { applyTrimAndClip, measureSong } from '../measure/song.ts';
import { integrated, truePeakDb } from '../measure/loudness.ts';
import { clippedSamples } from '../measure/envelope.ts';
import { renderSong, type RenderedSong } from '../render/song-pipeline.ts';
import { renderSongExcerpt } from '../render/song-excerpt.ts';
import { addChannels, layerWavPath, nullResidualDb, readChannels, renderLayers, reportedResidualDb, stateSong, stateTrim } from '../render/layers.ts';
import { lintSong, soundingPitch } from '../song-lint.ts';
import { compileSong } from '../../runtime/engine/sequence.js';
import { instrumentSpan } from '../../runtime/engine/song.js';
import { parseChord, voiceLead } from '../../runtime/engine/chords.js';
import { int, positiveInt, withHost } from './shared.ts';
import { canonicalJson, sha256 } from '../hash.ts';
import type { Song } from '../schema/song.ts';
import type { Patch } from '../schema/patch.ts';
import { foldAlbum, readAlbum, scanAlbums, updateAlbumTrack, writeAlbum } from '../album.ts';
import { albumIpUrls, albumUrl, registerProject } from '../audition/server.ts';
import { ensureServer } from './audition.ts';
import { planScore } from '../compat.ts';
import { rebaseInstrument, type FilterMode } from '../rebase.ts';
import { hzToMidi, noteToHz } from '../../runtime/engine/notes.js';
import { instrumentRoot } from '../../runtime/engine/song.js';
import { exportRole } from '../export-manifest.ts';
import { exportSongAssets } from '../export-assets.ts';
import { songRenderOptions } from '../render/options.ts';
import { hostScope } from '../render/host.ts';
import { mapPool } from '../pool.ts';

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** What the agent reads first about a rendered song; the full features are in meta.json. */
/** One notice per instrument a song names that a project patch of the same name has taken over from the library. */
const shadowNotices = (p: OpenProject, song: Song) => shadowedInstruments(p, song).map(name => notice('N_NAME_SHADOWED', {
  message: `${song.name} plays the project patch "${name}", not the library instrument of the same name`, requested: `library/${name}`, applied: 'project patch',
}));

/** A song whose trim was held at the limit plays away from its loudness target by the difference. */
const songTrimNotices = (r: RenderedSong) => {
  const c = r.features.delivered?.trimClamped;
  return c ? [notice('N_TRIM_CLAMPED', { message: `${r.song.name} needs ${c.requestedDb} dB of trim to reach the music loudness; the limit is ${c.appliedDb} dB, so it plays ${c.requestedDb < c.appliedDb ? 'louder' : 'quieter'} than the target`, requested: c.requestedDb, applied: c.appliedDb })] : [];
};

export function songSummary(r: RenderedSong, p: OpenProject, instruments: Record<string, Patch> = {}) {
  const f = r.features;
  return {
    name: r.song.name, title: r.song.title ?? null, cached: r.cached, wav: r.wavPath, look: r.lookPath, meta: r.dir + '/meta.json',
    length: mmss(f.durationSec), durationSec: f.durationSec, loop: r.song.loop, trimDb: r.trimDb,
    features: {
      loudnessLufs: f.delivered?.integratedLufs, truePeakDb: f.delivered?.truePeakDb, loudnessRangeLu: f.loudnessRangeLu,
      centroidHz: f.centroidHz, lowShare: f.lowShare, stereoWidth: f.stereoWidth, ...(f.seamDb !== undefined ? { seamDb: f.seamDb, seamEndLufs: f.seamEndLufs, seamStartLufs: f.seamStartLufs } : {}),
    },
    sections: f.sections.map(s => ({ name: s.name, at: mmss(s.start), lufs: s.lufs, centroidHz: s.centroidHz })),
    // A preview keeps the original mix level; whole-song loudness/form rules do not apply to it.
    ...(r.excerpt ? { excerpt: r.excerpt } : { lint: lintSong(r.song, f, p.project, instruments) }),
    // name@hash per track: when a render changes without a song edit, this says which instrument moved.
    instruments: Object.fromEntries(Object.entries(instruments).map(([t, x]) => [t, `${x.name}@${sha256(canonicalJson(x)).slice(0, 8)}`])),
    ...noticeField([...shadowNotices(p, r.song), ...songTrimNotices(r), ...songNotices(r.song)]),
  };
}

/** Event counts and sounding ranges per track, and the section timeline, without rendering. */
export function songOutline(song: Song, instruments: Record<string, Patch>) {
  const c = compileSong(song);
  const spans = Object.fromEntries(Object.entries(instruments).map(([t, p]) => [t, instrumentSpan(p)]));
  const perTrack: Record<string, { notes: number; lo: number | null; hi: number | null }> = {};
  for (const t of Object.keys(song.tracks)) perTrack[t] = { notes: 0, lo: null, hi: null };
  const sounding = soundingPitch(song, instruments);
  for (const e of c.events) {
    const t = perTrack[e.track];
    t.notes++;
    if (e.midi !== null) { t.lo = Math.min(t.lo ?? 999, e.midi); t.hi = Math.max(t.hi ?? -1, e.midi); }
  }
  return {
    name: song.name, bpm: song.bpm, length: mmss(c.length), lengthSec: Math.round(c.length * 100) / 100, loop: song.loop,
    sections: c.sections.map(s => ({ name: s.name, at: mmss(s.start), bars: s.bars })),
    // Each chords pattern's voicings as written: catch a pad sinking into the bass band here.
    voicings: Object.fromEntries(Object.entries(song.patterns).filter(([, pt]) => pt.chords).map(([name, pt]) => {
      const spec = pt.chords!;
      const chords = song.progressions[spec.progression].map(([sym]) => parseChord(sym));
      const v = voiceLead(chords, { octave: spec.octave, voicing: spec.voicing, slash: spec.slash });
      return [name, chords.map((ch, i) => `${ch.symbol}: ${v[i].map(m => midiName(m + pt.transpose)).join(' ')}`)];
    })),
    tracks: Object.fromEntries(Object.entries(perTrack).map(([k, v]) => {
      const span = spans[k];
      const notes = v.lo === null || v.hi === null ? null : `${midiName(v.lo)}-${midiName(v.hi)}`;
      const at = sounding[k] ?? ((m: number) => m);
      const sounds = v.lo === null || v.hi === null || !span ? null : `${midiName(at(v.lo) + span.low)}-${midiName(at(v.hi) + span.high)}`;
      return [k, { notes: v.notes, range: notes, ...(sounds && sounds !== notes ? { sounds } : {}), ...(v.notes === 0 ? { silent: true } : {}) }];
    })),
    ...noticeField(songNotices(song)),
  };
}

/**
 * Render songs across up to `jobs` headless browsers (each OfflineAudioContext runs on its own thread).
 * `only`: play just these tracks' notes out of each full song (see renderSong).
 */
export async function renderMany(p: OpenProject, songs: Song[], jobs = 3, only?: string[], verifyDeterminism = false): Promise<RenderedSong[]> {
  const instruments = songs.map(s => resolveInstruments(p, s));
  return mapPool(songs, jobs, (s, i, host) => renderSong(host, s, instruments[i], songRenderOptions(p, only?.length ? { only } : {})), hostScope({ verifyDeterminism }));
}

/** A part this far under the mix's peak (dB) is inaudible; nearer, it is an accent however quiet its integrated level. */
const STEM_PEAK_AUDIBLE_DB = 12;

export function registerSongCommands(program: Command, io: Io) {
  const instruments = program.command('instruments')
    .description('list the bundled instrument patches songs can play by name')
    .action(() => {
      // A project patch with a library instrument's name hides it from every song in this project: mark those, so the list is not read as what a song will play.
      let own = new Set<string>();
      try { own = new Set(listPatches(openProject(io.projectDir())).map(x => x.name)); } catch { /* no project: nothing can shadow */ }
      const list = libraryInstruments().map(i => (own.has(i.name) ? { ...i, shadowedBy: 'project patch' } : i));
      io.emit({ instruments: list, ...noticeField(list.filter(i => 'shadowedBy' in i).map(i => notice('N_NAME_SHADOWED', { message: `the project patch "${i.name}" hides the library instrument of the same name`, requested: `library/${i.name}`, applied: 'project patch' }))) });
    });

  instruments.command('rebase <name>')
    .description('print the song-instrument override that builds an instrument at another register, so a part written far from its root plays as built')
    .option('--by <semitones>', 'move every pitched layer by this many semitones (negative is down)', int)
    .option('--to <note>', 'move the instrument so its root is this note, such as F4')
    .option('--filters <mode>', 'follow: scale the cutoffs of the moved layers by the same ratio; keep: leave them', 'follow')
    .action((name: string, opts: { by?: number; to?: string; filters: string }) => {
      if ((opts.by === undefined) === (opts.to === undefined)) throw new BeepsError('E_USAGE', 'give exactly one of --by <semitones> or --to <note>');
      if (opts.filters !== 'follow' && opts.filters !== 'keep') throw new BeepsError('E_USAGE', `--filters must be follow or keep, not ${opts.filters}`);
      const patch = findInstrument(openProject(io.projectDir()), name);
      if (!patch) throw new BeepsError('E_NOT_FOUND', `no instrument "${name}"`, { hint: 'a project patch name or a library instrument (beeps instruments)' });
      const root = instrumentRoot(patch as never);
      if (root === null) throw new BeepsError('E_USAGE', `"${name}" has no pitched layer to rebase`);
      const shift = opts.by ?? Math.round(hzToMidi(noteToHz(opts.to!)) - root);
      const r = rebaseInstrument(patch, shift, { filters: opts.filters as FilterMode });
      io.emit({
        instrument: name, root: r.root, rebuiltRoot: r.rebuiltRoot, shiftSemitones: shift, filters: opts.filters, movedLayers: r.layers, scaledCutoffs: r.filters, ...(r.clamped ? { clampedCutoffs: r.clamped } : {}),
        override: { base: name, set: r.set },
        hint: `add it to the song's "instruments" block under a new name and point the track at that name; then write the part near ${r.rebuiltRoot}. Layers without a pitch keep their own filters.`,
      });
    });

  const song = program.command('song').description('compose, render and export music (beeps/song@1)');
  // A bare group command lists its subcommands instead of exiting silently.
  const listing = (cmd: Command) => () => io.emit({ usage: `beeps ${cmd.name()} <command>`, commands: cmd.commands.map(c => ({ name: c.name(), description: c.description() })) });
  song.action(listing(song));

  song.command('new <file>')
    .description('validate a song JSON file and save it to .agent-beeps/songs/<name>.json')
    .option('--force', 'replace an existing song of the same name')
    .action((file: string, opts: { force?: boolean }) => {
      const p = openProject(io.projectDir());
      const s = songOrThrow(readJsonFile(file), file);
      io.emit({ saved: saveSong(p, s, { force: !!opts.force }), ...songOutline(s, resolveInstruments(p, s)) });
    });

  song.command('list')
    .description('project songs and bundled library songs')
    .action(() => {
      const songs = listSongs(openProject(io.projectDir()));
      io.emit({ songs, ...noticeField(songs.filter(s => s.shadows).map(s => notice('N_NAME_SHADOWED', { message: `the project song "${s.name}" hides the library song of the same name (${s.shadows})`, requested: s.shadows, applied: 'project song' }))) });
    });

  song.command('check <refs...>')
    .description('validate songs and print their outline (sections, notes and range per track) without rendering')
    .action((refs: string[]) => {
      const p = openProject(io.projectDir());
      const loaded = refs.map(r => loadSong(p, r));
      io.emit({ songs: loaded.map(s => songOutline(s, resolveInstruments(p, s))), ...noticeField(loaded.flatMap(s => shadowNotices(p, s))) });
    });

  song.command('compat <refs...>')
    .description('plan crossfades between songs without rendering: tempo, loop length, estimated key, and per pair the tempo relation, phase-lock and harmony agreement')
    .option('--worst <n>', 'print only the n weakest pairs', int)
    .action((refs: string[], opts: { worst?: number }) => {
      const p = openProject(io.projectDir());
      const plan = planScore(refs.map(r => loadSong(p, r)));
      if (opts.worst !== undefined && opts.worst < 1) throw new BeepsError('E_USAGE', '--worst takes a count of 1 or more', { received: String(opts.worst) });
      if (opts.worst) plan.pairs = plan.pairs.sort((a, b) => a.harmony - b.harmony).slice(0, opts.worst);
      io.emit(plan);
    });

  song.command('render <refs...>')
    .description('render, loudness-trim, measure and lint songs; writes a WAV and a look image per song')
    .option('--jobs <n>', 'songs rendered in parallel (one headless browser each)', positiveInt, 3)
    .option('--only <tracks>', 'comma-separated tracks to keep (solo); the rest are muted')
    .option('--sections <names>', 'excerpt these sections from the full render, preserving mix context and level')
    .option('--verify-determinism', 'render each song twice and fail (E_NONDETERMINISTIC) when the two differ in any sample; doubles the render time')
    .action(async (refs: string[], opts: { jobs: number; only?: string; sections?: string; verifyDeterminism?: boolean }) => {
      const p = openProject(io.projectDir());
      const list = (x?: string) => x?.split(',').map(v => v.trim()).filter(Boolean);
      const selected = list(opts.sections);
      const only = list(opts.only);
      const loaded = refs.map(r => loadSong(p, r));
      // What a solo reports as: the song with only these tracks playing, not looping, so its tail shows.
      const songs = loaded.map(s => {
        if (!only?.length) return s;
        const solo = soloSong(s, { only });
        solo.title = `${s.title ?? s.name} — ${only.join(', ')} solo`;
        return solo;
      });
      if (selected) for (const s of songs) for (const name of selected) {
        if (!s.form.includes(name)) throw new BeepsError('E_USAGE', `no played section "${name}"`);
      }
      // A solo renders the full song with only these tracks' notes, so it plays the mix's chance
      // hits, arp orders and noise; it keeps its own (solo-normalized) level. Sections excerpt it as before.
      const renders = only?.length ? loaded.map((s, i) => ({ ...s, loop: false, title: songs[i].title })) : loaded;
      const out = (await renderMany(p, renders, opts.jobs, only, opts.verifyDeterminism)).map((r, i) => (only?.length ? { ...r, song: songs[i] } : r));
      const previews = selected ? await withHost(async host => {
        const results: RenderedSong[] = [];
        for (const r of out) results.push(await renderSongExcerpt(host, r, selected));
        return results;
      }) : out;
      io.emit({ songs: previews.map(r => ({ ...songSummary(r, p, resolveInstruments(p, r.song)),
        ...(only?.length ? { solo: { tracks: only, level: 'solo-normalized' } } : {}),
      })) });
    });

  song.command('stems <ref>')
    .description("render each track alone at the full mix's trim: per-track level, brightness, low end and section presence, plus stem WAVs")
    .option('--jobs <n>', 'stems rendered in parallel', positiveInt, 3)
    .option('--out <dir>', 'also copy the stem WAVs here')
    .action(async (ref: string, opts: { jobs: number; out?: string }) => {
      const p = openProject(io.projectDir());
      const s = loadSong(p, ref);
      const instruments = resolveInstruments(p, s);
      const [mix] = await renderMany(p, [s], 1);
      const tracks = Object.keys(s.tracks).filter(t => Object.values(s.sections).some(sec => sec.play[t] != null));
      const omittedTracks = Object.keys(s.tracks).filter(t => !tracks.includes(t));
      // Stems are the full song with one track's notes playing: they line up sample for sample
      // with the mix and draw the same chance hits, arp orders and noise.
      const stems = await mapPool(tracks, opts.jobs, (t, _i, host) => renderSong(host, s, instruments, songRenderOptions(p, { trimDb: mix.trimDb, only: [t] })), hostScope());
      if (opts.out) mkdirSync(resolve(opts.out), { recursive: true });
      const mixLufs = mix.features.delivered?.integratedLufs ?? 0;
      const report = {
        name: s.name, mix: { loudnessLufs: mixLufs, centroidHz: mix.features.centroidHz, lowShare: mix.features.lowShare },
        stems: tracks.map((t, i) => {
          const f = stems[i].features;
          const dest = opts.out ? join(resolve(opts.out), `${s.name}-${t}.wav`) : undefined;
          if (dest) copyFileSync(stems[i].wavPath, dest);
          // A stem with no sound has no integrated level (-Infinity, which JSON writes as null): say it is silent instead of printing a bare null.
          const lufs = f.delivered?.integratedLufs;
          const silent = lufs === undefined || !Number.isFinite(lufs);
          return {
            track: t, loudnessLufs: silent ? null : lufs, ...(silent ? { silent: true } : {}), vsMixLu: silent ? null : Math.round((lufs - mixLufs) * 10) / 10,
            // A short percussive part (a hat) sits far under the mix by integrated level and is still heard: its peak says so.
            peakVsMixDb: Math.round((f.samplePeakDb - mix.features.samplePeakDb) * 10) / 10, crestDb: f.crestDb,
            centroidHz: f.centroidHz, lowShare: f.lowShare, stereoWidth: f.stereoWidth,
            sections: f.sections.map(x => ({ name: x.name, lufs: x.lufs })), wav: dest ?? stems[i].wavPath, look: stems[i].lookPath,
          };
        }).sort((a, b) => (b.loudnessLufs ?? -Infinity) - (a.loudnessLufs ?? -Infinity)),
        // Tracks no section plays are not rendered: list them so a missing stem is not mistaken for a skipped one.
        ...(omittedTracks.length ? { omitted: omittedTracks.map(track => ({ track, reason: 'no section plays it' })) } : {}),
      };
      // A part far under the mix is felt, not heard; one within a few LU of it is carrying the song.
      // Integrated level undersells a sparse, peaky part, so a stem is only flagged when its peak is also well under the mix's peak.
      const quiet = report.stems.filter((x): x is typeof x & { vsMixLu: number } => x.vsMixLu !== null && x.vsMixLu < -18);
      const silentStems = report.stems.filter(x => x.silent).map(x => `${x.track} rendered silent: none of its notes made a sound, so check its instrument and the patterns the sections play for it`);
      const buried = quiet.filter(x => x.peakVsMixDb < -STEM_PEAK_AUDIBLE_DB).map(x => `${x.track} sits ${-x.vsMixLu} LU under the mix and its peak ${-x.peakVsMixDb} dB under: likely inaudible; raise its gainDb or drop it`);
      const accents = quiet.filter(x => x.peakVsMixDb >= -STEM_PEAK_AUDIBLE_DB).map(x => `${x.track} is ${-x.vsMixLu} LU under the mix by integrated level but its peak is within ${Math.max(0, -x.peakVsMixDb)} dB of the mix's (crest ${x.crestDb} dB): short and peaky, so it is heard as an accent; do not chase it with gain`);
      io.emit({ ...report, ...(buried.length || silentStems.length ? { warnings: [...silentStems, ...buried] } : {}), ...(accents.length ? { notes: accents } : {}) });
    });

  song.command('states <ref>')
    .description('adaptive songs: render the layers and judge every state as its own piece (level, trim, range, seam, brightness, register overlaps among only its tracks, lint)')
    .action(async (ref: string) => {
      const p = openProject(io.projectDir());
      const s = loadSong(p, ref);
      if (!s.adaptive) throw new BeepsError('E_USAGE', `song "${s.name}" has no "adaptive" block`);
      const instruments = resolveInstruments(p, s);
      const { mix, layers } = await withHost(async host => {
        const mix = await renderSong(host, s, instruments, songRenderOptions(p));
        return { mix, layers: await renderLayers(host, s, instruments, mix, songRenderOptions(p)) };
      });
      const sections = mix.features.sections.map(x => ({ name: x.name, start: x.start, end: x.end }));
      const sr = readWav(readFileSync(mix.wavPath)).sampleRate;
      const cache = new Map<string, Float32Array[]>();
      const chans = (name: string) => { let c = cache.get(name); if (!c) { c = readChannels(layers[name].wavPath); cache.set(name, c); } return c; };
      const states = Object.entries(s.adaptive.states).map(([state, names]) => {
        let sum: Float32Array[] | undefined;
        for (const n of names) sum = addChannels(sum, chans(n));
        const t = stateTrim(sum ?? [], sr, p.project.musicLoudness);
        const f = measureSong(sum ?? [], sr, sections, { loop: s.loop });
        const delivered = applyTrimAndClip(sum ?? [], t.trimDb);
        f.delivered = { integratedLufs: Math.round(integrated(delivered, sr).lufs * 100) / 100, truePeakDb: Math.round(truePeakDb(delivered, sr) * 100) / 100, clippedSamples: clippedSamples(delivered) };
        const tracks = names.flatMap(n => s.adaptive!.layers[n]);
        const lint = lintSong(stateSong(s, tracks), f, p.project, instruments);
        return {
          state, layers: names, tracks, rawLufs: t.lufs, trimDb: t.trimDb, playsAtLufs: t.silent ? null : f.delivered.integratedLufs,
          ...(t.silent ? { silent: true } : {}), ...(t.clamped ? { trimClamped: t.clamped } : {}),
          loudnessRangeLu: f.loudnessRangeLu, centroidHz: f.centroidHz, lowShare: f.lowShare, stereoWidth: f.stereoWidth, truePeakDb: f.delivered.truePeakDb,
          ...(f.seamDb !== undefined ? { seamDb: f.seamDb } : {}),
          sections: f.sections.map(x => ({ name: x.name, lufs: Math.round((x.lufs + t.trimDb) * 10) / 10, centroidHz: x.centroidHz })),
          lint: { errors: lint.errors, warnings: lint.warnings, overlaps: lint.judgementChecks.find(c => c.rule === 'song-register-bands')?.data },
        };
      });
      io.emit({ name: s.name, mixLufs: mix.features.delivered?.integratedLufs, states });
      if (states.some(x => x.lint.errors.length)) process.exitCode = 1;
    });

  song.command('lint <ref>')
    .description('render (or reuse) a song and check it against craft/music-rules.json')
    .action(async (ref: string) => {
      const p = openProject(io.projectDir());
      const s = loadSong(p, ref);
      const r = await withHost(host => renderSong(host, s, resolveInstruments(p, s), songRenderOptions(p)));
      const report = lintSong(s, r.features, p.project, resolveInstruments(p, s));
      io.emit({ name: s.name, ...report });
      if (report.errors.length) process.exitCode = 1;
    });

  song.command('export <ref>')
    .description('write the loudness-trimmed WAV of a song')
    .requiredOption('--wav <path>', 'output WAV path')
    .option('--manifest', 'write a portable <wav>.json sidecar for game integration')
    .option('--role <role>', 'manifest role: music (default), ambience or sfx; requires --manifest')
    .option('--layers', 'adaptive songs: also write each layer as <wav-stem>.<layer>.wav (loop-folded, at the mix trim) and list them in the sidecar')
    .option('--verify-determinism', 'render the song (and each layer) twice and fail (E_NONDETERMINISTIC) when the two differ in any sample; doubles the render time')
    .option('--trim-tail <dBFS>', 'non-loop songs: drop the end after the last sample at or above this level (e.g. -60), with a 10 ms fade; an opening that renders its whole reverb tail ends where it is audible. Default: off', parseFloat)
    .action(async (ref: string, opts: { wav: string; manifest?: boolean; role?: string; layers?: boolean; trimTail?: number; verifyDeterminism?: boolean }) => {
      if (opts.trimTail !== undefined && !(opts.trimTail < 0 && opts.trimTail >= -120)) throw new BeepsError('E_USAGE', '--trim-tail takes a level in dBFS from -120 to just below 0, e.g. -60');
      const role = exportRole(opts.role, opts.manifest, 'music');
      const p = openProject(io.projectDir());
      const s = loadSong(p, ref);
      if (opts.layers && !s.adaptive) throw new BeepsError('E_USAGE', `song "${s.name}" has no "adaptive" block`, { hint: 'add adaptive.layers, adaptive.states and adaptive.initial (see references/song-format.md)' });
      const dest = resolve(opts.wav);
      const { rendered: r, layerFiles, residual, stateTrimDb, stateLufs, manifest, warnings, post } = await withHost(host => exportSongAssets(host, p, s, { dest, role, manifest: !!opts.manifest, layers: !!opts.layers, ...(opts.trimTail !== undefined ? { trimTailDb: opts.trimTail } : {}) }), { verifyDeterminism: opts.verifyDeterminism });
      io.emit({ name: s.name, wav: dest, renderedWav: r.wavPath, loop: s.loop, durationSec: r.features.durationSec, ...(post?.trimmedTailSec !== undefined ? { trimmedTailSec: post.trimmedTailSec } : {}),
        ...(layerFiles ? { layers: layerFiles, nullResidualDb: reportedResidualDb(residual ?? -Infinity), ...(stateLufs ? { stateLufs, stateTrimDb } : {}) } : {}),
        ...(manifest ? { manifest } : {}), ...(warnings.length ? { warnings } : {}) });
    });

  const album = program.command('album').description('put rendered songs in front of the owner on the LAN listening page');
  album.action(listing(album));

  album.command('open <refs...>')
    .description('print album links immediately, then add each song as its render finishes')
    .option('--title <text>', 'album title', 'New music')
    .option('--jobs <n>', 'songs rendered in parallel', positiveInt, 3)
    .action(async (refs: string[], opts: { title: string; jobs: number }) => {
      const p = openProject(io.projectDir());
      const songs = refs.map(r => loadSong(p, r));
      const a = writeAlbum(p, {
        title: opts.title,
        tracks: songs.map(s => ({ name: s.name, title: s.title ?? s.name, description: s.description, loop: s.loop, status: 'pending' })),
      });
      const info = await ensureServer();
      registerProject(p.paths.root);
      io.emit({ album: a.id, status: 'rendering', url: albumUrl(info, a.id), ipUrls: albumIpUrls(info, a.id), tracks: a.tracks.map(t => ({ index: t.index, name: t.name, status: t.status })) });
      // Stdout remains one JSON document. Progress is JSON lines on stderr; the page polls the album.
      const progress = (value: object) => process.stderr.write(JSON.stringify({ album: a.id, ...value }) + '\n');
      // Each track records its own outcome, so one failed track never stops the others; mapPool only throws when a browser itself fails.
      const poolError = await mapPool(songs, opts.jobs, async (s, i, host) => {
        const index = i + 1;
        try {
          const r = await renderSong(host, s, resolveInstruments(p, s), songRenderOptions(p));
          updateAlbumTrack(p, a.id, index, {
            status: 'ready', renderKey: r.key, durationSec: r.features.durationSec, wav: r.wavPath, look: r.lookPath,
            sections: r.features.sections.map(x => ({ name: x.name, start: x.start, end: x.end })),
            features: { loudnessLufs: r.features.delivered?.integratedLufs, loudnessRangeLu: r.features.loudnessRangeLu, arc: r.features.arc },
          });
          progress({ index, status: 'ready' });
        } catch (e) {
          const error = (e as Error).message;
          updateAlbumTrack(p, a.id, index, { status: 'failed', error });
          progress({ index, status: 'failed', error });
        }
      }, hostScope()).then(() => undefined, (e: unknown) => ({ reason: e }));
      // A browser may fail before claiming a track. Never leave its unrendered slots pending forever.
      for (const t of readAlbum(p, a.id).tracks.filter(t => t.status === 'pending')) {
        const reason = poolError?.reason as { message?: unknown } | undefined;
        const error = poolError ? String(reason?.message ?? reason) : 'render did not complete';
        updateAlbumTrack(p, a.id, t.index, { status: 'failed', error });
        progress({ index: t.index, status: 'failed', error });
      }
      const done = readAlbum(p, a.id);
      const failures = done.tracks.filter(t => t.status === 'failed').map(t => ({ index: t.index, name: t.name, error: t.error }));
      // The first JSON (the links) is long printed; this last line is where a failed track is named, with why.
      progress({ status: 'complete', ready: done.tracks.length - failures.length, failed: failures.length, ...(failures.length ? { failures } : {}) });
      if (failures.length) process.exitCode = 1;
    });

  album.command('feedback <id>')
    .description("the owner's marks, tags and notes per track")
    .action((id: string) => {
      const p = openProject(io.projectDir());
      const a = readAlbum(p, id);
      const s = foldAlbum(a, p);
      io.emit({ album: a.id, title: a.title, note: s.note || null, tracks: s.tracks, heard: s.tracks.filter(t => t.plays > 0).length });
    });

  album.command('list')
    .description('albums in this project')
    .action(() => {
      const { albums, unreadable } = scanAlbums(openProject(io.projectDir()));
      io.emit({ albums: albums.map(a => ({ id: a.id, title: a.title, tracks: a.tracks.length, ready: a.tracks.filter(t => t.status === 'ready').length, failed: a.tracks.filter(t => t.status === 'failed').length, createdAt: a.createdAt })), ...(unreadable.length ? { unreadable } : {}) });
    });
}
