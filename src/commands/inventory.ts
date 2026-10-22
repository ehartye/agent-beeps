import type { Command } from 'commander';

/** Groups that also run on their own (`beeps instruments` lists the library); every other group only lists its subcommands. */
const GROUPS_THAT_RUN = new Set(['instruments']);

export interface CommandEntry { name: string; description: string }

/**
 * Every runnable command, as the full name an agent types after `beeps` ("song stems", not just "song"). Groups that only
 * hold subcommands are not listed. This is the one inventory: `capabilities`, the generated docs/cli.md and the
 * command-coverage test all read it, so none of them can drift from what the CLI actually registers.
 */
export function leafCommands(program: Command): CommandEntry[] {
  const out: CommandEntry[] = [];
  const walk = (cmd: Command, prefix: string) => {
    for (const sub of cmd.commands) {
      const name = prefix ? `${prefix} ${sub.name()}` : sub.name();
      if (sub.commands.length === 0) out.push({ name, description: sub.description() });
      else {
        if (GROUPS_THAT_RUN.has(name)) out.push({ name, description: sub.description() });
        walk(sub, name);
      }
    }
  };
  walk(program, '');
  return out;
}
