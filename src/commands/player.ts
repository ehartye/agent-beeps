// src/commands/player.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { bundleDir } from '../bundle.ts';
import { BeepsError } from '../errors.ts';
import { checkLoops, compressBundle } from '../compress.ts';
import { engineCheck, parseEngines } from '../engine-check.ts';
import { networkInterfaces } from 'node:os';
import { RUNTIME_DIR, serveStatic } from '../render/host.ts';
import { parseSelftestFormats, writeSelftest } from '../selftest.ts';
import { ENGINE_VERSION } from '../../runtime/engine/version.js';
import { PLAYER_VERSION } from '../../runtime/player/version.js';

/** Runtime files the vendored player needs (relative to runtime/): its modules and the engine modules they import. */
export const PLAYER_FILES = [
  'player/player.js', 'player/player.d.ts', 'player/version.js', 'player/voices.js', 'player/timing.js', 'player/lifecycle.js', 'player/loader.js', 'player/params.js',
  'engine/fx.js', 'engine/rng.js', 'engine/variation.js', 'engine/notes.js',
];

/** Copy the player into <dir>/beeps-player/, keeping relative imports; games import player/player.js. */
export function exportPlayer(dir: string): { root: string; files: string[]; entry: string; version: string } {
  const root = join(resolve(dir), 'beeps-player');
  // beeps-player/ is tool-owned: clear it first so a re-export never leaves a file from an older
  // version (a renamed or removed module) sitting alongside the new set.
  rmSync(root, { recursive: true, force: true });
  const pkg = JSON.parse(readFileSync(join(RUNTIME_DIR, '..', 'package.json'), 'utf8')) as { version: string };
  const header = `// Vendored by agent-beeps ${pkg.version} (player ${PLAYER_VERSION}, engine ${ENGINE_VERSION}). Regenerate with "beeps player export"; do not edit.\n`;
  for (const f of PLAYER_FILES) {
    const dest = join(root, f);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, header + readFileSync(join(RUNTIME_DIR, f), 'utf8'));
  }
  writeFileSync(join(root, 'VERSION.json'), JSON.stringify({ agentBeeps: pkg.version, player: PLAYER_VERSION, engine: ENGINE_VERSION }, null, 2) + '\n');
  return { root, files: PLAYER_FILES.map(f => join(root, f)), entry: join(root, 'player', 'player.js'), version: pkg.version };
}

export function registerPlayerCommands(program: Command, io: Io) {
  program.command('bundle <dir>')
    .description('collect the export sidecars (*.wav.json) under a directory into <dir>/index.json, the catalog the game player loads')
    .action((dir: string) => io.emit(bundleDir(resolve(dir))));
  program.command('compress <dir> <outDir>')
    .description('re-encode an exported bundle (WAVs and *.wav.json sidecars) as Ogg Opus in <outDir>, verify frame counts, alignment and loop wraps, and write its index.json')
    .option('--music-kbps <n>', 'music and adaptive layers (default 56)', Number)
    .option('--ambience-kbps <n>', 'ambience beds (default 48)', Number)
    .option('--sfx-kbps <n>', 'sound effects (default 72)', Number)
    .option('--mix-kbps <n>', "the full-mix file of an adaptive song, which the player does not load (it plays the layers); default: same as music", Number)
    .option('--format <opus|mp3>', 'output format: opus (Ogg Opus, default) or mp3 (the fallback for browsers with no Ogg Opus decoder; default kbps 80/64/96)', 'opus')
    .option('--no-strict', 'report a file that does not verify instead of failing')
    .action((dir: string, outDir: string, o: { musicKbps?: number; ambienceKbps?: number; sfxKbps?: number; mixKbps?: number; format: string; strict: boolean }) => {
      if (o.format !== 'opus' && o.format !== 'mp3') throw new BeepsError('E_USAGE', `--format must be opus or mp3, not ${o.format}`);
      const r = compressBundle(dir, outDir, { format: o.format, kbps: { ...(o.musicKbps ? { music: o.musicKbps } : {}), ...(o.ambienceKbps ? { ambience: o.ambienceKbps } : {}), ...(o.sfxKbps ? { sfx: o.sfxKbps } : {}), ...(o.mixKbps ? { mix: o.mixKbps } : {}) } });
      io.emit({ ...r, checks: o.strict ? r.checks.filter(c => c.problems.length || c.warnings?.length || c.wrap) : r.checks });
      if (r.problems.length && o.strict) process.exitCode = 1;
    });
  program.command('loopcheck <files...>')
    .description('decode encoded audio (ogg, mp3, wav...) and report its frame count against the sidecar and how its loop wraps: click size, level step and seam metrics; --engines also decodes it in real browsers')
    .option('--engines <list>', 'also decode each file with OfflineAudioContext.decodeAudioData in these Playwright engines (chromium,firefox,webkit) at 48000 and 44100 Hz and report frame delta and start lead against the source')
    .option('--source <path>', 'the source WAV, or a directory of them, for the lead (default: <name>.wav beside the file, else the file as ffmpeg decodes it)')
    .option('--require-engines', 'exit non-zero when a requested engine is not installed or has no Web Audio, instead of reporting it as skipped')
    .action(async (files: string[], o: { engines?: string; source?: string; requireEngines?: boolean }) => {
      const engines = o.engines ? parseEngines(o.engines) : undefined;
      const r = checkLoops(files.map(f => resolve(f)), { source: o.source ? resolve(o.source) : undefined });
      const engineReports = engines ? await engineCheck(files.map(f => resolve(f)), engines, { source: o.source ? resolve(o.source) : undefined }) : undefined;
      io.emit({ files: r, ...(engineReports ? { engines: engineReports } : {}) });
      const engineFailed = engineReports?.some(e => e.status === 'error' || (o.requireEngines && e.status !== 'ok') || e.files.some(f => f.results.some(x => x.problems.length)));
      if (r.some(x => x.problems.length) || engineFailed) process.exitCode = 1;
    });
  const player = program.command('player').description('the browser runtime games use to play exported audio');
  player.command('selftest [dir]')
    .description('write a static self-test page (beeps-selftest/) that decodes a known loop in the delivered formats through the vendored player and prints frame delta and lead per audio-context rate, with a copyable result: open it on a real iPhone or Safari')
    .option('--formats <list>', 'encodes to include, besides the WAV control: opus, mp3', 'opus,mp3')
    .option('--serve', 'also serve the page on the LAN until interrupted, and print the URLs')
    .option('--port <n>', 'port for --serve (default: any free port)', Number)
    .action(async (dir: string | undefined, o: { formats: string; serve?: boolean; port?: number }) => {
      const r = writeSelftest(dir ?? '.', parseSelftestFormats(o.formats));
      if (!o.serve) { io.emit({ ...r, hint: 'serve the folder over HTTP (or add --serve) and open index.html in the browser to test; iOS needs HTTP(S), not file://' }); return; }
      const site = await serveStatic(r.root, { host: '0.0.0.0', port: o.port ?? 0 });
      const urls = Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => `http://${a!.address}:${site.port}/`);
      io.emit({ ...r, serving: { port: site.port, urls: urls.length ? urls : [site.url + '/'] }, hint: 'open a URL on the phone or Mac Safari, tap Run, tap Copy result; Ctrl-C stops the server' });
      await new Promise<void>(res => { process.once('SIGINT', () => res()); process.once('SIGTERM', () => res()); });
      site.server.close();
    });
  player.command('export <dir>')
    .description('vendor the player into <dir>/beeps-player/, replacing that folder (import beeps-player/player/player.js)')
    .action((dir: string) => io.emit(exportPlayer(dir)));
}
