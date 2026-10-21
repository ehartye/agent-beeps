import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli.ts';
import { leafCommands } from '../src/commands/inventory.ts';

const root = join(import.meta.dirname, '..');
const markdown = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? markdown(path) : path.endsWith('.md') ? [path] : [];
});
const commands = leafCommands(buildProgram({ emit() {}, projectDir: () => process.cwd() }));

// An agent finds a command through a skill or a reference it links, or through the README. A command in none of them
// exists only in --help, which an agent has no reason to open: this keeps the three inventories from drifting apart.
describe('command coverage', () => {
  const agentText = [join(root, 'README.md'), ...markdown(join(root, 'skills'))].map(p => readFileSync(p, 'utf8')).join('\n');
  const mentioned = (name: string) => new RegExp(`(^|[^a-z-])${name.replaceAll(' ', '[ `]+')}([^a-z-]|$)`).test(agentText);

  it('lists every runnable command', () => {
    expect(commands.length).toBeGreaterThan(70);
    expect(commands.map(c => c.name)).toEqual(expect.arrayContaining(['render', 'song stems', 'store pull', 'instruments', 'instruments rebase']));
  });

  it('mentions every command in the README, a skill or one of their references', () => {
    expect(commands.filter(c => !mentioned(c.name)).map(c => c.name)).toEqual([]);
  });

  it('gives every command a description', () => {
    expect(commands.filter(c => !c.description.trim()).map(c => c.name)).toEqual([]);
  });
});
