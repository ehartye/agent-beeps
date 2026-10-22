import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const markdown = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? markdown(path) : path.endsWith('.md') ? [path] : [];
});

// A skill points at its references and at repository docs by path. A moved or renamed file otherwise leaves a link an agent
// follows into nothing, with no error until it tries.
it('every relative markdown link and every repository path in a skill resolves', () => {
  const broken: string[] = [];
  for (const file of markdown(join(root, 'skills'))) {
    const text = readFileSync(file, 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      if (!existsSync(resolve(dirname(file), target))) broken.push(`${file.slice(root.length + 1)} -> ${target}`);
    }
    for (const [, target] of text.matchAll(/`((?:skills|docs|craft|library|runtime)\/[A-Za-z0-9_./-]+\.(?:md|json|js|ts|mjs))`/g)) {
      if (!existsSync(join(root, target))) broken.push(`${file.slice(root.length + 1)} -> ${target}`);
    }
  }
  expect(broken).toEqual([]);
});
