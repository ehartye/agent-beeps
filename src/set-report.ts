// What a generating command did with the candidates it tried, so a short set is never mistaken for a full one.
// generate and mutate oversample, drop what fails to render or breaks a craft rule, and keep a diverse few: the report says
// how many were asked for, kept, dropped (and why) and passed over, and the notices say when that fell short.
import { BeepsError } from './errors.ts';
import { lintPatch } from './lint.ts';
import { notice, noticeField, type Notice } from './notices.ts';
import type { OpenProject } from './project.ts';
import type { Rendered, RenderOutcome } from './render/pipeline.ts';
import type { Patch } from './schema/patch.ts';
import { evaluateExpectations } from './expect.ts';

/** A candidate that was tried and could not be kept: it failed to render, or broke an error-level craft rule. */
export interface Dropped { name: string; reason: 'render' | 'lint' | 'expectation'; detail: string; /** expectation: the kinds of check the candidate missed. */ checks?: string[] }

/** Always `tried = kept + notSelected + dropped.length`: a candidate cannot vanish without being counted. */
export interface SetReport {
  requested: number;
  kept: number;
  /** Candidates rendered. */
  tried: number;
  dropped: Dropped[];
  /** Usable candidates passed over by the diversity or direction selection. */
  notSelected: number;
  /** mutate: how many candidates missed each kind of check in the parent's xExpect block (a candidate missing two counts in both). */
  expectationMisses?: Record<string, number>;
  /** mutate: perturbations equal to the parent, never rendered. */
  unchanged?: number;
  /** mutate --like: children whose blend with the other patch was not a valid patch, bred from the parent alone. */
  blendFallbacks?: number;
}

/** Split renders into those worth choosing among and those dropped (a failed render, or an error-level lint finding), with why. */
export function screen(rendered: RenderOutcome[], p: OpenProject, brief?: Patch['xExpect']): { usable: Rendered[]; dropped: Dropped[] } {
  const usable: Rendered[] = [], dropped: Dropped[] = [];
  for (const r of rendered) {
    if (!r.ok) { dropped.push({ name: r.patchName, reason: 'render', detail: r.error }); continue; }
    const errors = lintPatch(r.patch, r.features, p.project).errors;
    if (errors.length) { dropped.push({ name: r.patch.name, reason: 'lint', detail: errors.map(e => e.rule).join(', ') }); continue; }
    // A child is checked against the brief of the sound it was bred from (not inherited: it carries no block of its own).
    const missed = brief ? evaluateExpectations({ ...r.patch, xExpect: brief }, [r.features]).checks.filter(c => c.outcome !== 'pass') : [];
    if (missed.length) dropped.push({ name: r.patch.name, reason: 'expectation', checks: [...new Set(missed.map(c => c.kind))], detail: missed.map(c => `${c.kind} ${c.outcome === 'unmeasurable' ? 'unmeasurable' : `${c.actual}${c.unit ? ' ' + c.unit : ''} vs ${JSON.stringify(c.expected)}`}`).join('; ') });
    else usable.push(r);
  }
  return { usable, dropped };
}

export function setReport(requested: number, usable: Rendered[], dropped: Dropped[], kept: number, extra: Pick<SetReport, 'unchanged' | 'blendFallbacks'> = {}): SetReport {
  const misses: Record<string, number> = {};
  for (const d of dropped) for (const kind of d.checks ?? []) misses[kind] = (misses[kind] ?? 0) + 1;
  return { requested, kept, tried: usable.length + dropped.length, dropped, notSelected: usable.length - kept, ...(Object.keys(misses).length ? { expectationMisses: misses } : {}), ...extra };
}

/** E_RENDER when nothing survived: an empty set is a failure, not a result. */
export function requireCandidates(report: SetReport, what: string): void {
  if (report.kept > 0) return;
  const by = (reason: Dropped['reason']) => report.dropped.filter(d => d.reason === reason).length;
  throw new BeepsError('E_RENDER', `no ${what} could be kept: ${by('lint')} broke a craft rule, ${by('render')} failed to render${by('expectation') ? ` and ${by('expectation')} missed the expectations of the patch they were bred from` : ''}, of ${report.tried} tried`, {
    hint: by('expectation') ? 'the direction you asked for may contradict the xExpect block of the patch (see report.expectationMisses): change the block, or pass --ignore-expect' : 'rerun with another --seed; the first dropped candidates are in details.report.dropped',
    details: { report: { ...report, dropped: report.dropped.slice(0, 10) } },
  });
}

export interface Steering { directions: string[]; cancelled: [string, string][]; applied: boolean }

/** The notices for a finished set: a short set, and a prompt that could not steer. */
export function setNotices(report: SetReport, steering?: Steering): Notice[] {
  const out: Notice[] = [];
  if (report.kept < report.requested) {
    out.push(notice('N_SHORT_SET', {
      message: `asked for ${report.requested}, kept ${report.kept}: ${report.dropped.length} of ${report.tried} candidates were dropped and ${report.notSelected} usable ones passed over`,
      requested: report.requested, applied: report.kept,
    }));
  }
  for (const [a, b] of steering?.cancelled ?? []) out.push(notice('N_STEERING_CANCELLED', { message: `the prompt asks for both ${a} and ${b}, so neither steered the selection` }));
  if (steering && steering.directions.length && !steering.applied) {
    out.push(notice('N_STEERING_UNUSED', {
      message: `the prompt was read as ${steering.directions.join(', ')}, but only ${report.tried - report.dropped.length} usable candidates were left for ${report.requested} places, so steering chose nothing`,
      requested: steering.directions, applied: [],
    }));
  }
  return out;
}

/** The JSON a generating command adds to its set: the report, and any notices. */
export const reportJson = (g: { report: SetReport; notices: Notice[] }) => ({ report: g.report, ...noticeField(g.notices) });
