// src/commands/player.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { bundleDir } from '../bundle.ts';
import { checkLoops, compressBundle } from '../compress.ts';
import { RUNTIME_DIR } from '../render/host.ts';
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
    .option('--no-strict', 'report a file that does not verify instead of failing')
    .action((dir: string, outDir: string, o: { musicKbps?: number; ambienceKbps?: number; sfxKbps?: number; strict: boolean }) => {
      const r = compressBundle(dir, outDir, { kbps: { ...(o.musicKbps ? { music: o.musicKbps } : {}), ...(o.ambienceKbps ? { ambience: o.ambienceKbps } : {}), ...(o.sfxKbps ? { sfx: o.sfxKbps } : {}) } });
      io.emit({ ...r, checks: o.strict ? r.checks.filter(c => c.problems.length || c.wrap) : r.checks });
      if (r.problems.length && o.strict) process.exitCode = 1;
    });
  program.command('loopcheck <files...>')
    .description('decode encoded audio (ogg, mp3, wav...) and report its frame count against the sidecar and how its loop wraps: click size and level step')
    .action((files: string[]) => {
      const r = checkLoops(files.map(f => resolve(f)));
      io.emit({ files: r });
      if (r.some(x => x.problems.length)) process.exitCode = 1;
    });
  const player = program.command('player').description('the browser runtime games use to play exported audio');
  player.command('export <dir>')
    .description('vendor the player into <dir>/beeps-player/, replacing that folder (import beeps-player/player/player.js)')
    .action((dir: string) => io.emit(exportPlayer(dir)));
}
