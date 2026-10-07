export type ErrorCode =
  | 'E_USAGE' | 'E_SCHEMA' | 'E_NOT_FOUND' | 'E_RENDER' | 'E_BROWSER_MISSING' | 'E_RUNTIME_MISSING'
  | 'E_SERVER' | 'E_PREDICTION_REQUIRED' | 'E_CONFLICT' | 'E_PROJECT'
  | 'E_LOCK' | 'E_STORE' | 'E_VERIFY' | 'E_TOOLCHAIN' | 'E_BUDGET';

export const ERROR_CODES: ErrorCode[] = ['E_USAGE', 'E_SCHEMA', 'E_NOT_FOUND', 'E_RENDER', 'E_BROWSER_MISSING',
  'E_RUNTIME_MISSING', 'E_SERVER', 'E_PREDICTION_REQUIRED', 'E_CONFLICT', 'E_PROJECT',
  'E_LOCK', 'E_STORE', 'E_VERIFY', 'E_TOOLCHAIN', 'E_BUDGET'];

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
