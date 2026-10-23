# Reading notices and reports

`beeps` means `node "<plugin-root>/scripts/run-managed.js"`. A command that changed, dropped or ignored something you asked for says so in
a `notices` array: `code`, `severity`, `message`, and `pointer`, `requested`, `applied` and `hint` where they apply. Match on `code`.
Every code is in `docs/notices.md` (generated from the registry, so it cannot be out of date). A notice never fails a command; a failure is
an error with `category` and `retryable`. Do not describe a result as "as written", or a set as the size you asked for, while a notice says otherwise.

## Pitch and level

- `N_SCALE_SNAP`: the project scale moved a pitch (466 Hz renders as another note). Write in-scale pitches, or set `scale.snap` to false.
- `N_TRIM_CLAMPED`: the sound is so far from the loudness target that the trim hit its limit, so it plays above or below the target. Re-gain its loudest layer.
- `N_INPUT_CLAMPED`: a runtime input value was outside its declared range, so the nearest end was used. `runtime look` and `runtime live` reject an input the patch does not declare.

## Sets

- `generate` and `mutate` return a `report`: `requested`, `kept`, `tried`, `dropped` (a reason each), `notSelected`. `N_SHORT_SET` means the set is smaller than you asked for: say so, and why.
- `N_STEERING_CANCELLED` and `N_STEERING_UNUSED`: the prompt words steered nothing (opposite words, or too few candidates to choose between).
- A set with nothing in it is `E_RENDER`, with the first drops in `details.report`. A parent that does not render is `E_RENDER` too.

## Variants, names, the kit

- `N_VARIANTS_IDENTICAL`: the declared variants render the same samples. Add `pitchCents` (pitched layers) or `gainDb`. `N_NO_VARIANTS`: the patch declares none.
- `N_NAME_SHADOWED`: a project patch or song hides a library one of the same name (`instruments`, `song list`, `song check`, `song render`).
- `N_KIT_REPLACED`: `kit add` replaced an entry; `replaced` has its previous priority, trim and seed. The audition seed is kept.
- Render, measure, look, lint and kit check use the seed recorded in the kit for a kit sound, the same one export uses, unless you pass `--seed`.
- `kit check` lists a sound that failed to render as `ok: false` and exits 1. `crossover` errors on an invalid blend and needs `--force` to overwrite.
- `batch` lists `noops` (a remove of a key the patch did not have); `init` on an existing project reports what it `ignored` (`N_OPTION_IGNORED`).

## Files and documents

- A key a document does not know is an `E_SCHEMA` error with a `pointer` and `received` (in `project.json`, an instrument override, a batch operation, a build recipe). It is almost always a typo: fix the spelling, do not look for the setting it was meant to reach.
- `N_OPTION_IGNORED`: an option was accepted and had no effect (`init --scale` on an existing project).
- `build` returns `warnings` for what an export said while building (layers that do not sum, channels that differ).

## Songs

- `N_PATTERN_TRUNCATED` (`song new`, `song check`, `song render`): a pattern is longer than its section, so notes past the end never sound. Lengthen the section or shorten the pattern.
- `N_DELAY_TAIL_CAPPED`: a delay would ring longer than the 8 seconds the render keeps. Lower its feedback or time.
- `song stems` lists `omitted` tracks (no section plays them) and marks a stem `silent: true` (with `loudnessLufs: null`) when none of its notes sounded. A silent adaptive state has `silent: true` and `null` levels, not -99.
- `album open` ends its stderr progress with `failures` (index, name, error) when a track failed; `album list` counts `ready` and `failed` tracks.
- `N_UNUSED_FIELD` (`song new`, `song check`, `song render`): `hitBeats` or `note` on a pattern with no `steps`, or more than four values in a note tuple. They change nothing.
- `N_RUNTIME_AT_DEFAULTS` (info): the patch has `xRuntime` inputs and this baked render used each at its default; `beeps runtime check` lints the corners.
- Lists say what they left out: `album list` (`unreadable`), `bundle` (`skipped`), `audition status` (`malformedEvents`), `export` (`replaced`, `stale` variant files), `family` (short CSV rows in `warnings`).
- `pitchHz: null` comes with a `pitchReason`. `generate` and `mutate` print the `seed` they used, so a good set can be asked for again.
