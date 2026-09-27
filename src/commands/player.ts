// src/commands/player.ts
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { bundleDir } from '../bundle.ts';

export function registerPlayerCommands(program: Command, io: Io) {
  program.command('bundle <dir>')
    .description('collect the export sidecars (*.wav.json) under a directory into <dir>/index.json, the catalog the game player loads')
    .action((dir: string) => io.emit(bundleDir(resolve(dir))));
}
