import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

// The repo is a publishable plugin: examples are abstract and nothing may name a private game or a personal machine.
const root = join(import.meta.dirname, '..');
const self = 'tests/hygiene.test.ts';
const skipFiles = new Set(['package-lock.json', self]);
const binaryExt = /\.(png|jpe?g|gif|webp|ico|wav|ogg|opus|mp3|flac|mp4|webm|woff2?|ttf|otf|zip|gz|pdf|wasm|glb)$/i;

// The allowed exception list is empty on purpose. Add a path here only with a comment saying why a hit is unavoidable.
const allowed = new Set<string>();

const denyList: Array<[string, RegExp]> = [
  ['owner surname', /\behart\b/i],
  ['Windows user path', /[a-z]:[\\/]+users/i], // also matches JSON-escaped "C:\\Users"
  ['Git Bash user path', /\/[a-z]\/users\//i],
  ['Unix or macOS home path', /\/Users\/[a-z]/i],
  ['Linux home path', /\/home\/[a-z]/i],
  ['personal hostname', /hal[- ]?9000/i],
  ['private game', /room2grow/i],
  ['private game', /space[- ]to[- ]grow/i],
  ['private game asset prefix', /\bstg-/],
  ['private game', /sector[ -]?run/i],
  ['private game', /fallow[ -]?valley/i],
  ['private game', /clementines?/i],
  ['private game', /dead[ -]?redline/i],
  ['private game', /the-upside/i],
  ['private game', /sproutpost/i],
  ['private game', /wingnut/i],
  ['private game', /plot ?7/i],
  ['private game art direction', /frank miller/i],
  ['private game level', /cinder[ -]?viaduct/i],
  ['private game level', /salt run/i],
  ['private game level', /dead forest/i],
  ['private game level', /drowned ocean/i],
  ['private game level', /red mesa/i],
  ['private game asset id', /mus-desert/i],
  ['private game asset id', /music-garden/i],
];

const hitLabels = (text: string): string[] => denyList.filter(([, re]) => re.test(text)).map(([label]) => label);

function isBinary(path: string): boolean {
  if (binaryExt.test(path)) return true;
  const fd = openSync(join(root, path), 'r');
  try {
    const buf = Buffer.alloc(8000);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** Tracked paths, or null when this is not a git checkout (a tarball or a plugin cache has no index to list). */
function trackedFiles(): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter((p) => p && !skipFiles.has(p) && !allowed.has(p));
  } catch {
    return null;
  }
}
const files = trackedFiles();
const fix = 'abstract the example, or add the file to `allowed` in tests/hygiene.test.ts with a comment saying why the hit is unavoidable';

describe('deny-list patterns', () => {
  it.each([
    ['C:\\Users\\bob', 'Windows user path'],
    ['"C:\\\\Users\\\\bob"', 'Windows user path'],
    ['D:\\users\\x', 'Windows user path'],
    ['C:/Users/bob', 'Windows user path'],
    ['/c/Users/bob', 'Git Bash user path'],
    ['/Users/Bob', 'Unix or macOS home path'],
    ['/home/bob', 'Linux home path'],
    ['HAL-9000', 'personal hostname'],
    ['hal9000', 'personal hostname'],
    ['Hal 9000', 'personal hostname'],
    ['ehart', 'owner surname'],
    ['Frank Miller', 'private game art direction'],
    ['Salt Run', 'private game level'],
    ['Red Mesa', 'private game level'],
    ['mus-desert', 'private game asset id'],
  ])('flags %s', (text, label) => {
    expect(hitLabels(text)).toContain(label);
  });

  it.each(['https://github.com/ehartye/agent-beeps', 'ehartye', 'Eric M Hartye', 'hartye-plugins', 'Hartye marketplace', '/usr/local/bin', '/Users'])('does not flag publisher identity or generic text: %s', (text) => {
    expect(hitLabels(text)).toEqual([]);
  });
});

describe.skipIf(files === null)('repo hygiene', () => {
  it('has no private game, personal path or personal machine in any tracked file name', () => {
    const hits = (files ?? []).flatMap((path) => hitLabels(path).map((label) => `${path} [${label}] (file name)`));
    expect(hits, `\n${hits.join('\n')}\n${fix}\n`).toEqual([]);
  });

  it('names no private game, personal path or personal machine in any tracked text file', () => {
    const hits: string[] = [];
    for (const path of files ?? []) {
      if (isBinary(path)) continue;
      readFileSync(join(root, path), 'utf8').split('\n').forEach((line, i) => {
        for (const label of hitLabels(line)) hits.push(`${path}:${i + 1} [${label}] ${line.trim().slice(0, 100)}`);
      });
    }
    expect(hits, `\n${hits.join('\n')}\n${fix}\n`).toEqual([]);
  });
});

if (files === null) console.warn('tests/hygiene.test.ts: skipped the tracked-file scan because this is not a git checkout (git ls-files failed).');
