// What a generating command did with the candidates it tried, so a short set is never mistaken for a full one.
// generate and mutate oversample, drop what fails to render or breaks a craft rule, and keep a diverse few: the report says
// how many were asked for, kept, dropped (and why) and passed over, and the notices say when that fell short.
import { BeepsError } from './errors.ts';
import { lintPatch } from './lint.ts';
import { notice, noticeField, type Notice } from './notices.ts';
import type { OpenProject } from './project.ts';
import type { Rendered, RenderOutcome } from './render/pipeline.ts';

/** A candidate that was tried and could not be kept: it failed to render, or broke an error-level craft rule. */
export interface Dropped { name: string; reason: 'render' | 'lint'; detail: string }

/** Always `tried = kept + notSelected + dropped.length`: a candidate cannot vanish without being counted. */
export interface SetReport {
  requested: number;
  kept: number;
  /** Candidates rendered. */
  tried: number;
  dropped: Dropped[];
  /** Usable candidates passed over by the diversity or direction selection. */
  notSelected: number;
  /** mutate: perturbations equal to the parent, never rendered. */
  unchanged?: number;
  /** mutate --like: children whose blend with the other patch was not a valid patch, bred from the parent alone. */
  blendFallbacks?: number;
}

/** Split renders into those worth choosing among and those dropped (a failed render, or an error-level lint finding), with why. */
export function screen(rendered: RenderOutcome[], p: OpenProject): { usable: Rendered[]; dropped: Dropped[] } {
  const usable: Rendered[] = [], dropped: Dropped[] = [];
  for (const r of rendered) {
    if (!r.ok) { dropped.push({ name: r.patchName, reason: 'render', detail: r.error }); continue; }
    const errors = lintPatch(r.patch, r.features, p.project).errors;
    if (errors.length) dropped.push({ name: r.patch.name, reason: 'lint', detail: errors.map(e => e.rule).join(', ') });
    else usable.push(r);
  }
  return { usable, dropped };
}

export function setReport(requested: number, usable: Rendered[], dropped: Dropped[], kept: number, extra: Pick<SetReport, 'unchanged' | 'blendFallbacks'> = {}): SetReport {
  return { requested, kept, tried: usable.length + dropped.length, dropped, notSelected: usable.length - kept, ...extra };
}

/** E_RENDER when nothing survived: an empty set is a failure, not a result. */
export function requireCandidates(report: SetReport, what: string): void {
  if (report.kept > 0) return;
  const by = (reason: Dropped['reason']) => report.dropped.filter(d => d.reason === reason).length;
  throw new BeepsError('E_RENDER', `no ${what} could be kept: ${by('lint')} broke a craft rule and ${by('render')} failed to render, of ${report.tried} tried`, {
    hint: 'rerun with another --seed; the first dropped candidates are in details.report.dropped',
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
