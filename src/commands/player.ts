// src/commands/player.ts
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { bundleDir } from '../bundle.ts';
import { RUNTIME_DIR } from '../render/host.ts';
import { ENGINE_VERSION } from '../../runtime/engine/version.js';
import { PLAYER_VERSION } from '../../runtime/player/player.js';

/** Runtime files the vendored player needs (relative to runtime/): its modules and the engine modules they import. */
export const PLAYER_FILES = [
  'player/player.js', 'player/voices.js', 'player/timing.js', 'player/lifecycle.js', 'player/loader.js', 'player/params.js',
  'engine/fx.js', 'engine/rng.js', 'engine/variation.js', 'engine/notes.js',
];

/** Copy the player into <dir>/beeps-player/, keeping relative imports; games import player/player.js. */
export function exportPlayer(dir: string): { root: string; files: string[]; version: string } {
  const root = join(resolve(dir), 'beeps-player');
  const pkg = JSON.parse(readFileSync(join(RUNTIME_DIR, '..', 'package.json'), 'utf8')) as { version: string };
  for (const f of PLAYER_FILES) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    cpSync(join(RUNTIME_DIR, f), join(root, f));
  }
  const player = join(root, 'player', 'player.js');
  const header = `// Vendored by agent-beeps ${pkg.version} (player ${PLAYER_VERSION}, engine ${ENGINE_VERSION}). Regenerate with "beeps player export"; do not edit.\n`;
  writeFileSync(player, header + readFileSync(player, 'utf8'));
  writeFileSync(join(root, 'VERSION.json'), JSON.stringify({ agentBeeps: pkg.version, player: PLAYER_VERSION, engine: ENGINE_VERSION }, null, 2) + '\n');
  return { root, files: PLAYER_FILES.map(f => join(root, f)), version: pkg.version };
}

export function registerPlayerCommands(program: Command, io: Io) {
  program.command('bundle <dir>')
    .description('collect the export sidecars (*.wav.json) under a directory into <dir>/index.json, the catalog the game player loads')
    .action((dir: string) => io.emit(bundleDir(resolve(dir))));
  const player = program.command('player').description('the browser runtime games use to play exported audio');
  player.command('export <dir>')
    .description('vendor the player into <dir>/beeps-player/ (import beeps-player/player/player.js)')
    .action((dir: string) => io.emit(exportPlayer(dir)));
}
