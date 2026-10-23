// beeps: JSON on stdout, one-line JSON error on stderr with a stable code, non-zero exit on failure.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command, CommanderError } from 'commander';
import { BeepsError, toErrorJson } from './errors.ts';
import { drainNotices } from './notices.ts';
import { registerPatchCommands } from './commands/patches.ts';
import { registerCapabilities } from './commands/capabilities.ts';
import { registerAuditionCommands } from './commands/audition.ts';
import { registerGenerateCommands } from './commands/generate.ts';
import { registerFamilyCommands } from './commands/family.ts';
import { registerSongCommands } from './commands/songs.ts';
import { registerPlayerCommands } from './commands/player.ts';
import { registerBuildCommands } from './commands/build.ts';
import { registerRuntimeCommands } from './commands/runtime.ts';
import { registerAnalyzeCommands } from './commands/analyze.ts';
import { registerSampleCommands } from './commands/samples.ts';

const root = join(import.meta.dirname, '..');
export const VERSION: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

export interface Io { emit(value: unknown): void; projectDir(): string }

/** Notices raised while reading inputs (a project file with a stray key) join the command's own `notices` in the one JSON it prints. */
function withAmbientNotices(value: unknown): unknown {
  const extra = drainNotices();
  if (!extra.length || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const own = (value as { notices?: unknown[] }).notices ?? [];
  return { ...value, notices: [...own, ...extra] };
}

export function buildProgram(io: Io): Command {
  const program = new Command('beeps')
    .description('Procedural sound composer for coding agents')
    .version(VERSION)
    .option('--project <dir>', 'project directory (default: nearest ancestor with .agent-beeps)')
    .option('--pretty', 'indent JSON output')
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: s => process.stdout.write(s) });
  registerCapabilities(program, io);
  registerPatchCommands(program, io);
  registerGenerateCommands(program, io);
  registerFamilyCommands(program, io);
  registerAuditionCommands(program, io);
  registerSongCommands(program, io);
  registerPlayerCommands(program, io);
  registerBuildCommands(program, io);
  registerRuntimeCommands(program, io);
  registerAnalyzeCommands(program, io);
  registerSampleCommands(program, io);
  return program;
}

export async function main(argv: string[]): Promise<void> {
  let pretty = argv.includes('--pretty');
  let program: Command | undefined;
  const io: Io = {
    emit: value => console.log(JSON.stringify(withAmbientNotices(value), null, pretty ? 2 : undefined)),
    projectDir: () => (program?.opts().project as string | undefined) ?? process.cwd(),
  };
  program = buildProgram(io);
  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') return;
      console.error(JSON.stringify({ error: toErrorJson(new BeepsError('E_USAGE', e.message.replace(/^error: /, ''))) }));
      process.exitCode = 2;
      return;
    }
    console.error(JSON.stringify({ error: toErrorJson(e) }));
    process.exitCode = 1;
  }
}
