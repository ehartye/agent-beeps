import { expect, it } from 'vitest';
import { summarize } from '../scripts/ci-suite.mjs';

const test = (title: string, status = 'passed') => ({ title, status });
const suite = (name: string, assertionResults = [test('required')]) => ({ name: `/checkout/${name}`, assertionResults });
const report = (...extra: ReturnType<typeof suite>[]) => ({ success: true, numTotalTests: 2 + extra.length, numPassedTests: 2, testResults: [suite('tests/engine/graph-golden.test.ts'), suite('tests/hygiene.test.ts'), ...extra] });

it('names legitimate Firefox and host-permission skips', () => {
  const r = report(suite('tests/player/selftest.test.ts', [test('reports a result in Firefox too', 'pending')]), suite('tests/player/bundle.test.ts', [test('reports an unreadable sidecar file as E_NOT_FOUND with the OS message', 'skipped')]));
  expect(summarize(r)).toContain('2 legitimate skips');
  expect(summarize(r)).toContain('Firefox is outside');
  expect(summarize(r)).toContain('host cannot enforce');
});

it('rejects silently missing Chromium coverage or a new undocumented skip', () => {
  expect(() => summarize(report(suite('tests/cli.test.ts', [test('renders a patch', 'pending')])))).toThrow(/unexpected/);
});

it('rejects failed suites, empty reports, and missing or skipped golden/hygiene coverage', () => {
  expect(() => summarize({ ...report(), success: false })).toThrow(/successfully/);
  expect(() => summarize({ ...report(), numTotalTests: 0 })).toThrow(/successfully/);
  expect(() => summarize({ ...report(), testResults: [] })).toThrow(/missing/);
  const r = report(); r.testResults[0].assertionResults[0].status = 'pending';
  expect(() => summarize(r)).toThrow(/required coverage/);
});

it('does not mistake an allowed test failure for a legitimate skip', () => {
  expect(() => summarize(report(suite('tests/player/selftest.test.ts', [test('reports a result in Firefox too', 'failed')])))).toThrow(/unexpected/);
});
