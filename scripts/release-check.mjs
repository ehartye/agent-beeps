// Run before and after a release (see docs/RELEASING.md). Local checks always; --remote also checks origin.
//   node scripts/release-check.mjs            versions, descriptions and the README heading agree
//   node scripts/release-check.mjs --remote   plus: tag v<version> exists on origin and points at origin/main,
//                                             and origin/runtime's package.json carries <version>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { releaseProblems } from '../src/release.ts';

const root = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const problems = releaseProblems(root);

if (process.argv.includes('--remote')) {
  git('fetch', 'origin', '--tags', '--quiet');
  const tag = git('ls-remote', '--tags', 'origin', `refs/tags/v${version}`).split('\t')[0];
  if (!tag) problems.push(`origin has no tag v${version}`);
  else if (tag !== git('rev-parse', 'origin/main')) problems.push(`tag v${version} is ${tag.slice(0, 7)}, origin/main is ${git('rev-parse', '--short', 'origin/main')}`);
  let runtime;
  try { runtime = JSON.parse(git('show', 'origin/runtime:package.json')).version; } catch { runtime = undefined; }
  if (runtime !== version) problems.push(`origin/runtime package.json is ${JSON.stringify(runtime)}, expected ${version}`);
}

if (problems.length) { for (const p of problems) console.error(p); process.exit(1); }
console.log(`release ${version}: consistent${process.argv.includes('--remote') ? ' (local and origin)' : ''}`);
