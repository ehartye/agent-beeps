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
  N_SHORT_SET: {
    severity: 'warn',
    summary: 'A command returned fewer candidates than were asked for, because the rest failed to render or broke an error-level craft rule.',
    hint: 'read report.dropped for each candidate and why, then rerun with another --seed or a looser prompt; do not describe the set as the size you asked for',
  },
  N_STEERING_CANCELLED: {
    severity: 'info',
    summary: 'The prompt asked for opposite things (brighter and darker, shorter and longer), so neither steered the selection.',
    hint: 'keep one of the two words in the prompt, or pick candidates by looking at the sheet',
  },
  N_STEERING_UNUSED: {
    severity: 'info',
    summary: 'The prompt was read as directions, but the usable candidate pool was no larger than the set, so there was nothing to choose between and steering changed nothing.',
    hint: 'ask for a smaller --count, or generate again; use mutate --toward to move a chosen candidate in a direction',
  },
  N_OPTION_IGNORED: {
    severity: 'warn',
    summary: 'An option was accepted but had no effect, because what it configures already exists.',
    hint: 'edit the existing file (for example .agent-beeps/project.json) to change it',
  },
  N_TRIM_CLAMPED: {
    severity: 'warn',
    summary: 'The loudness trim the sound needs is further than the pipeline allows, so it was held at the limit and the sound sits above or below its loudness target.',
    hint: 'a sound that far from the target is usually mis-gained: raise or lower its loudest layer (gainDb), or check that it is not near-silent or extremely loud',
  },
  N_INPUT_CLAMPED: {
    severity: 'warn',
    summary: 'A runtime input value was outside its declared range, so the nearest end of the range was used.',
    hint: 'pass a value inside the input\'s declared min and max, or widen the range in the patch\'s xRuntime block',
  },
  N_KIT_REPLACED: {
    severity: 'warn',
    summary: 'Adding a sound replaced an entry of the same name in the project kit, and the replaced entry carried a value that is now different or gone.',
    hint: 'read replaced for the previous priority, trim and seed; add with --priority to set the priority you want',
  },
  N_NAME_SHADOWED: {
    severity: 'warn',
    summary: 'A project patch or song has the same name as a library one, so the library entry is hidden and the project one is used.',
    hint: 'rename the project entry if you meant the library one, or call the library entry by a name it does not share',
  },
  N_PATTERN_TRUNCATED: {
    severity: 'warn',
    summary: 'A pattern is longer than the section that plays it, so the notes past the end of the section were cut off and never sound.',
    hint: 'lengthen the section, shorten the pattern, or split the pattern so its tail has a section to play in',
  },
  N_DELAY_TAIL_CAPPED: {
    severity: 'info',
    summary: 'The feedback tail of a delay is longer than the render keeps (8 seconds), so the end of the tail was cut.',
    hint: 'lower the delay feedback or time, or accept that the tail ends at 8 seconds',
  },
  N_UNUSED_FIELD: {
    severity: 'warn',
    summary: 'A field is valid but has no effect where it is written, so it changes nothing: a rhythm field on a pattern that has no steps, or extra numbers after a note tuple\'s velocity.',
    hint: 'move the field to where it applies, or remove it',
  },
  N_RUNTIME_AT_DEFAULTS: {
    severity: 'info',
    summary: 'The patch declares runtime inputs, and this baked render used each input at its default. A game that sets the inputs plays other sounds.',
    hint: 'beeps runtime check lints the patch at the corners of its inputs, and beeps runtime look draws a chosen input value',
  },
  N_PARTIAL_ABOVE_NYQUIST: {
    severity: 'warn',
    summary: 'At the highest note a track plays, an instrument partial or layer would sound at or above 0.45 of the sample rate, so it aliases or is dropped.',
    hint: 'write the part lower, use an instrument with fewer high partials, or set the track transpose/root so the top notes stay lower',
  },
  N_CUTOFF_CAPPED: {
    severity: 'warn',
    summary: 'A keytracked filter cutoff would follow the highest note past the 22 kHz cap the engine applies, so the filter stops opening there and the top notes are darker than the keytrack suggests.',
    hint: 'lower the keytrack, start the cutoff lower, or accept that the top notes stop brightening',
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
