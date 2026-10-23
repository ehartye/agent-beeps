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
