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
  ['Windows user path', /C:[\/]+Users/i],
  ['Git Bash user path', /\/c\/Users\//],
  ['Unix home path', /\/Users\/[a-z]/],
  ['personal hostname', /hal9000/i],
  ['private game', /room2grow/i],
  ['private game', /space[- ]to[- ]grow/i],
  ['private game asset prefix', /\bstg-/],
  ['private game', /sector[ -]?run/i],
  ['private game', /fallow[ -]?valley/i],
  ['private game', /clementine/i],
  ['private game', /dead[ -]?redline/i],
  ['private game level', /cinder[ -]?viaduct/i],
];

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

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((p) => p && !skipFiles.has(p) && !allowed.has(p));
}

describe('repo hygiene', () => {
  it('does not match the surname rule against the publisher identity', () => {
    expect(denyList[0]![1].test('github.com/ehartye/agent-beeps')).toBe(false);
    expect(denyList[0]![1].test('Eric M Hartye')).toBe(false);
  });

  it('names no private game, personal path or personal machine in any tracked text file', () => {
    const hits: string[] = [];
    for (const path of trackedFiles()) {
      if (isBinary(path)) continue;
      const lines = readFileSync(join(root, path), 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const [label, re] of denyList) {
          if (re.test(line)) hits.push(`${path}:${i + 1} [${label}] ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(hits, `\n${hits.join('\n')}\n`).toEqual([]);
  });
});
