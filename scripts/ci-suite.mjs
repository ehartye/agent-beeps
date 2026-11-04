import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const optionalFirefox = new Map([
  ['tests/build/runtime-delivery.test.ts', ["compares Firefox's voice with Chromium's bake by features, and the tonal cues pass"]],
  ['tests/player/engine-check.test.ts', ['decodes the tagged MP3 exactly in Firefox']],
  ['tests/player/selftest.test.ts', ['reports a result in Firefox too']],
]);
const hostPermissions = [
  'rejects an asset path that is a symlink',
  'rejects an asset path that is a junction (a link that needs no elevation on Windows)',
  'reports an unreadable sidecar file as E_NOT_FOUND with the OS message',
  'skips a junction instead of following it into another directory',
];

/** @param {{success: boolean, numTotalTests: number, numPassedTests: number, testResults: Array<{name: string, assertionResults: Array<{title: string, status: string}>}>}} report */
export function summarize(report) {
  if (!report.success || !(report.numTotalTests > 0) || !Array.isArray(report.testResults)) throw new Error('suite did not complete successfully');
  const required = new Set(['tests/engine/graph-golden.test.ts', 'tests/hygiene.test.ts']);
  const skips = [];
  for (const suite of report.testResults) {
    const file = suite.name.replaceAll('\\', '/').split('/tests/').pop();
    const path = `tests/${file}`;
    const assertions = suite.assertionResults;
    if (!Array.isArray(assertions) || !assertions.length) throw new Error(`empty test file: ${path}`);
    if (required.has(path)) {
      if (assertions.some(test => test.status !== 'passed')) throw new Error(`required coverage did not pass: ${path}`);
      required.delete(path);
    }
    for (const test of assertions) {
      if (test.status === 'passed') continue;
      const reason = optionalFirefox.get(path)?.includes(test.title) ? 'Firefox is outside the Chromium CI lane'
        : path === 'tests/player/bundle.test.ts' && hostPermissions.includes(test.title) ? 'host cannot enforce the required file permission/link behavior' : undefined;
      if (!['pending', 'skipped'].includes(test.status) || !reason) throw new Error(`unexpected non-passing test: ${path}: ${test.title} (${test.status})`);
      skips.push(`- ${path}: ${test.title} — ${reason}`);
    }
  }
  if (required.size) throw new Error(`required test files missing: ${[...required].join(', ')}`);
  return `Full suite: ${report.numPassedTests} passed; ${skips.length} legitimate skips.\n\n${skips.join('\n') || 'No skipped tests.'}\n`;
}

export async function preflight() {
  // An absent browser/encoder must fail this lane rather than silently skip render/codec coverage.
  const { chromium } = await import('playwright');
  const { findFfmpeg } = await import('../src/compress.ts');
  const tracked = execFileSync('git', ['ls-files', '--', 'tests/engine/graph-golden.test.ts', 'tests/hygiene.test.ts'], { encoding: 'utf8' });
  if (!tracked.includes('graph-golden.test.ts') || !tracked.includes('hygiene.test.ts')) throw new Error('CI requires a Git checkout with golden and hygiene tests');
  const encoders = execFileSync(findFfmpeg(), ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 15000 });
  for (const codec of ['libopus', 'libmp3lame']) if (!encoders.includes(codec)) throw new Error(`FFmpeg lacks ${codec}`);
  const browser = await chromium.launch({ timeout: 30000 });
  try {
    const page = await browser.newPage();
    const frames = await page.evaluate(async () => (await new OfflineAudioContext(1, 128, 48000).startRendering()).length);
    if (frames !== 128) throw new Error('Chromium offline audio preflight failed');
  } finally { await browser.close(); }
  console.log('Required runtimes ready: Chromium offline audio, FFmpeg Opus/MP3, Git checkout.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'preflight') await preflight();
    else if (process.argv[2] === 'report' && process.argv[3]) {
      const summary = summarize(JSON.parse(readFileSync(process.argv[3], 'utf8')));
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    } else throw new Error('Usage: node scripts/ci-suite.mjs preflight | report <vitest.json>');
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
