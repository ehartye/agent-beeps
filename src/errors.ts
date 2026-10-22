export type ErrorCode =
  | 'E_USAGE' | 'E_SCHEMA' | 'E_NOT_FOUND' | 'E_RENDER' | 'E_BROWSER_MISSING' | 'E_RUNTIME_MISSING'
  | 'E_SERVER' | 'E_PREDICTION_REQUIRED' | 'E_CONFLICT' | 'E_PROJECT'
  | 'E_LOCK' | 'E_STORE' | 'E_VERIFY' | 'E_TOOLCHAIN' | 'E_BUDGET' | 'E_NONDETERMINISTIC'
  | 'E_INTERNAL';

export const ERROR_CODES: ErrorCode[] = ['E_USAGE', 'E_SCHEMA', 'E_NOT_FOUND', 'E_RENDER', 'E_BROWSER_MISSING',
  'E_RUNTIME_MISSING', 'E_SERVER', 'E_PREDICTION_REQUIRED', 'E_CONFLICT', 'E_PROJECT',
  'E_LOCK', 'E_STORE', 'E_VERIFY', 'E_TOOLCHAIN', 'E_BUDGET', 'E_NONDETERMINISTIC', 'E_INTERNAL'];

export interface ErrorJson { code: ErrorCode; message: string; pointer?: string; hint?: string; [detail: string]: unknown }

/** An error an agent can act on: a stable code, the JSON pointer at fault, a hint, and structured details. */
export class BeepsError extends Error {
  readonly code: ErrorCode;
  readonly pointer?: string;
  readonly hint?: string;
  readonly details: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, extra: { pointer?: string; hint?: string; details?: Record<string, unknown> } = {}) {
    super(message);
    this.code = code;
    this.pointer = extra.pointer;
    this.hint = extra.hint;
    this.details = extra.details ?? {};
  }
  toJson(): ErrorJson {
    return {
      code: this.code, message: this.message,
      ...(this.pointer !== undefined ? { pointer: this.pointer } : {}),
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
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
      code: 'E_INTERNAL', message,
      hint: 'this is a bug in beeps, not your input; rerun with BEEPS_DEBUG=1 for the stack and report it',
      ...(debug && (e as Error).stack ? { stack: (e as Error).stack } : {}),
    };
  }
  return { code: 'E_RENDER', message };
}
