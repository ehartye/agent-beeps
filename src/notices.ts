// Notices: what a command changed, dropped or ignored on the caller's behalf, as data an agent can match on. A notice never
// fails a command (a failure is an error with an exit code); it exists so nothing the tool does silently becomes a false
// belief. Commands build one with `notice(code, ...)` and never by hand, so the registry (and docs/notices.md, generated
// from it) lists every code that can appear. Output only: a notice never enters a render key, a hash or a manifest.

export interface NoticeEntry {
  /** `warn` when the caller may be acting on a false belief, `info` when the output is merely narrower than it might look. */
  severity: 'info' | 'warn';
  /** What the notice means, for docs/notices.md and `capabilities`. */
  summary: string;
  /** What to do about it; the notice's own `hint` wins when a call site knows better. */
  hint: string;
}

export const NOTICE_REGISTRY = {
  N_SCALE_SNAP: {
    severity: 'warn',
    summary: 'A pitched layer renders at a different pitch than written, because the project scale snaps pitches to its notes.',
    hint: 'write a pitch that is in the scale, change the scale in .agent-beeps/project.json, or set scale.snap to false to render pitches as written',
  },
  N_VARIANTS_IDENTICAL: {
    severity: 'warn',
    summary: 'The patch declares several variants, but nothing in its variation block changes the sound, so every variant renders the same samples.',
    hint: 'add variation.pitchCents (needs a pitched layer) or variation.gainDb, or author sibling patches that differ',
  },
  N_NO_VARIANTS: {
    severity: 'info',
    summary: 'Variants were requested for a patch that declares no variants, so one render was made.',
    hint: 'declare variation.variants in the patch (see the beeps-compose skill) before asking for variants',
  },
} as const satisfies Record<string, NoticeEntry>;

export type NoticeCode = keyof typeof NOTICE_REGISTRY;
export const NOTICE_CODES = Object.keys(NOTICE_REGISTRY) as NoticeCode[];

export interface Notice {
  code: NoticeCode;
  severity: 'info' | 'warn';
  message: string;
  /** JSON pointer into the patch or input the notice is about. */
  pointer?: string;
  /** What the caller asked for, and what applied instead. */
  requested?: unknown;
  applied?: unknown;
  hint?: string;
}

export interface NoticeDetails { message: string; pointer?: string; requested?: unknown; applied?: unknown; hint?: string }

export function notice(code: NoticeCode, d: NoticeDetails): Notice {
  const entry: NoticeEntry = NOTICE_REGISTRY[code];
  return {
    code, severity: entry.severity, message: d.message,
    ...(d.pointer !== undefined ? { pointer: d.pointer } : {}),
    ...(d.requested !== undefined ? { requested: d.requested } : {}),
    ...(d.applied !== undefined ? { applied: d.applied } : {}),
    hint: d.hint ?? entry.hint,
  };
}

/** `{ notices }` for spreading into a command's JSON, and nothing at all when there is nothing to say. */
export const noticeField = (list: Notice[]): { notices?: Notice[] } => (list.length ? { notices: list } : {});
