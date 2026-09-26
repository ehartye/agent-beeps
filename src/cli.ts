// beeps: JSON on stdout, one-line JSON error on stderr with a stable code, non-zero exit on failure.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command, CommanderError } from 'commander';
import { BeepsError } from './errors.ts';
import { registerPatchCommands } from './commands/patches.ts';
import { registerCapabilities } from './commands/capabilities.ts';
import { registerAuditionCommands } from './commands/audition.ts';
import { registerGenerateCommands } from './commands/generate.ts';

const root = join(import.meta.dirname, '..');
export const VERSION: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

export interface Io { emit(value: unknown): void; projectDir(): string }

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
  registerAuditionCommands(program, io);
  return program;
}

export async function main(argv: string[]): Promise<void> {
  let pretty = argv.includes('--pretty');
  let program: Command | undefined;
  const io: Io = {
    emit: value => console.log(JSON.stringify(value, null, pretty ? 2 : undefined)),
    projectDir: () => (program?.opts().project as string | undefined) ?? process.cwd(),
  };
  program = buildProgram(io);
  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') return;
      console.error(JSON.stringify({ error: { code: 'E_USAGE', message: e.message.replace(/^error: /, '') } }));
      process.exitCode = 2;
      return;
    }
    const err = e instanceof BeepsError ? e : new BeepsError('E_RENDER', (e as Error)?.message ?? String(e));
    console.error(JSON.stringify({ error: err.toJson() }));
    process.exitCode = 1;
  }
}
