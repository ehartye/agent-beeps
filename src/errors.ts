export type ErrorCode =
  | 'E_USAGE' | 'E_SCHEMA' | 'E_NOT_FOUND' | 'E_RENDER' | 'E_BROWSER_MISSING' | 'E_RUNTIME_MISSING'
  | 'E_SERVER' | 'E_PREDICTION_REQUIRED' | 'E_CONFLICT' | 'E_PROJECT'
  | 'E_LOCK' | 'E_STORE' | 'E_VERIFY' | 'E_TOOLCHAIN' | 'E_BUDGET' | 'E_NONDETERMINISTIC'
  | 'E_INTERNAL';

/**
 * What a caller should do about each code. `input`: change what you passed. `environment`: install or repair, then rerun.
 * `outcome`: the work ran and the result is unacceptable. `transient`: the same command may succeed later. `bug`: a defect in beeps.
 * Keyed by code, so a new ErrorCode does not compile until it has a category.
 */
export type ErrorCategory = 'input' | 'environment' | 'outcome' | 'transient' | 'bug';
export const ERROR_CATEGORIES: Record<ErrorCode, ErrorCategory> = {
  E_USAGE: 'input', E_SCHEMA: 'input', E_NOT_FOUND: 'input', E_CONFLICT: 'input', E_PROJECT: 'input', E_PREDICTION_REQUIRED: 'input', E_BUDGET: 'input',
  E_BROWSER_MISSING: 'environment', E_RUNTIME_MISSING: 'environment', E_TOOLCHAIN: 'environment',
  E_RENDER: 'outcome', E_VERIFY: 'outcome', E_NONDETERMINISTIC: 'outcome',
  E_LOCK: 'transient', E_SERVER: 'transient', E_STORE: 'transient',
  E_INTERNAL: 'bug',
};

export const ERROR_CODES = Object.keys(ERROR_CATEGORIES) as ErrorCode[];

export interface ErrorJson { code: ErrorCode; category: ErrorCategory; retryable: boolean; message: string; pointer?: string; hint?: string; received?: string; [detail: string]: unknown }

/** The rejected value as an agent reads it: JSON, cut to 80 characters. */
const echo = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
};

/** Both fields follow from the code, so no throw site names them. */
const triage = (code: ErrorCode) => ({ category: ERROR_CATEGORIES[code], retryable: ERROR_CATEGORIES[code] === 'transient' });

/** An error an agent can act on: a stable code, the JSON pointer at fault, a hint, and structured details. */
export class BeepsError extends Error {
  readonly code: ErrorCode;
  readonly pointer?: string;
  readonly hint?: string;
  readonly received?: unknown;
  readonly details: Record<string, unknown>;
  /** `received` is the value that was rejected (found at `pointer`); it is echoed to the caller, truncated. */
  constructor(code: ErrorCode, message: string, extra: { pointer?: string; hint?: string; received?: unknown; details?: Record<string, unknown> } = {}) {
    super(message);
    this.code = code;
    this.pointer = extra.pointer;
    this.hint = extra.hint;
    this.received = extra.received;
    this.details = extra.details ?? {};
  }
  toJson(): ErrorJson {
    return {
      code: this.code, ...triage(this.code), message: this.message,
      ...(this.pointer !== undefined ? { pointer: this.pointer } : {}),
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      ...(this.received !== undefined ? { received: echo(this.received) } : {}),
      ...this.details,
    };
  }
}

/**
 * What an uncaught error looks like on stderr. A BeepsError is already an agent-readable failure. A TypeError or
 * ReferenceError is a bug in beeps (nothing the caller typed makes one), so it gets its own code instead of posing as a
 * render failure; any other plain error is work that ran and failed, which is what E_RENDER means.
 */
export function toErrorJson(e: unknown, debug: boolean = !!process.env.BEEPS_DEBUG): ErrorJson {
  if (e instanceof BeepsError) return e.toJson();
  const message = (e as Error)?.message ?? String(e);
  if (e instanceof TypeError || e instanceof ReferenceError) {
    return {
      code: 'E_INTERNAL', ...triage('E_INTERNAL'), message,
      hint: 'this is a bug in beeps, not your input; rerun with BEEPS_DEBUG=1 for the stack and report it',
      ...(debug && (e as Error).stack ? { stack: (e as Error).stack } : {}),
    };
  }
  return { code: 'E_RENDER', ...triage('E_RENDER'), message };
}
