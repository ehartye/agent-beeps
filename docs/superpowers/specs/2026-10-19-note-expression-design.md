# Expressive song notes

The owner approved the proposed first slice: velocity changes tone/envelopes, and notes can carry
pitch and brightness curves. The listening test is the same eight bars with and without expression.

## Authoring contract

Existing `[beat, note, length, velocity?]` notes remain valid. Add an object form:

```json
{"at": 0, "note": "D4", "beats": 2, "vel": 0.7,
 "expression": {"pitch": [[0, -2], [0.25, 0]], "brightness": [[0, -1], [1, 0.5]]}}
```

Curve points are `[beatOffset, value, arrivalCurve?]`, relative to the note onset. `arrivalCurve`
is `linear` (default) or `step`. Pitch values are semitones (-24..24); brightness is octaves
(-4..4) applied to the instrument's existing layer filters. Each curve starts at zero time,
has strictly increasing times, 1..64 points, finite values, and ends no later than the authored
note length. Gate and section boundaries clip the curve at the actual held duration, interpolating
the boundary value. That value holds through the release. Expressive notes require a held gate,
not `gate: "patch"`. Empty expression objects are rejected.

Tracks opt into velocity response with `velocityInput: "touch"`, naming an existing `xRuntime`
input on the instrument. The final performed velocity (including pattern scale/humanization)
maps 0..1 across that input's min..max. Reuse `applyParams(..., true)` for onset changes, including
filter, FM index and amp envelope targets. Existing velocity output gain still applies.
An undeclared/unbound input, or binding to a shared effect bus, is an authoring error. Validate
the resulting patch values. Existing scores with no opt-in retain their event shape and DSP path.

## Engine

The compiler converts curve offsets to seconds without new random draws. Each voice schedules
its own detune parameters for pitch and filter detune for brightness, preserving existing patch
pitch/filter envelopes and LFOs. Distinct voices never share expressive AudioParams. Scheduling is
identical in eager, lazy, solo and full-mix renders. Fail early on a pitch curve with no pitched
source, or a brightness curve with no layer filter.

Velocity changes must not mutate a cached instrument. Tail sizing accounts for actual performed
velocity changes to note duration/release, including generated patterns and patch-duration gates.
No-expression graphs and PCM get explicit regression checks; expression gets real-browser signal,
timing, deterministic repeat, stem isolation and tail checks. Render identity must invalidate old
audio where necessary without accepting old cached expression renders.

## Delivery

Document the schema and musical units, add a reproducible eight-bar A/B study using the existing
album/listening UI, render and inspect its looks, and update the public showcase's engine hash
manifest after engine changes. Keep loudness and true peak measured. The wiki records design,
as-built architecture, validation and the actual listening-acceptance status.

## Work plan

1. Establish focused baseline tests in an isolated feature worktree.
2. Schema/compiler tests fail first; add strict object notes, velocityInput and curve compilation.
3. Engine tests fail first; add onset mappings, note-local automation, validation and tail sizing.
4. Add real-browser regression and deterministic-render checks, then review schema and engine.
5. Author and render the A/B study, document use, refresh showcase assets and run appropriate checks.
6. Review the final change, rebase, squash merge, verify Pages, and synchronize the wiki.
