# The vendored game player

`createPlayer(opts)` (from `runtime/player/player.js`, vendored by `beeps player export`) returns
one object a game keeps for the session. Read the source for exact behavior; this is the working
summary.

## Options

```js
createPlayer({
  catalog: '/audio/index.json',        // a URL, or an in-memory { assets: {...} }
  baseUrl,                             // asset URLs resolve against this (default: catalog's own directory)
  voices: 8,                           // total concurrent SFX voices
  defaults: { cooldownSec: 0.05, cap: 3 }, // fallback: a per-call value wins, then the asset's, then this
  onError(e) {},                       // { code, message, id? } — see "Error codes" below
  context,                             // an existing AudioContext to reuse
  contextFactory: () => new AudioContext(), // or build one lazily instead
  fetcher: url => fetch(url),          // swap in a test double
  seed: 1,                             // seeds each sound's own variant picker
});
```

## Lifecycle

- **`unlock()`** — call from a user gesture (a click, a key, a tap handler). Creates or resumes the
  `AudioContext` and starts anything queued while it could not run. Returns `Promise<boolean>`
  (whether it is now running); never rejects. Call it again on later gestures — cheap once running.
- **`setHidden(hidden)`** — suspends the context while the tab is hidden and resumes it when shown
  again (no new gesture needed: the original `unlock()` already carries sticky activation). Wiring
  this is the game's job, not the player's — **required**:

  ```js
  document.addEventListener('visibilitychange', () => player.setHidden(document.hidden));
  ```

- **`setEnabled(enabled)`** — a mute/off switch distinct from tab visibility: stops everything with a
  fade, then suspends; re-enabling needs the next `unlock()`-driven gesture to resume.
- **`stopAll(fadeSec?)`** — fades out every voice and both beds and clears the voice budget.
- **`retry()`** — forgets failed loads: a file that failed twice (then silent) and a failed catalog
  (retry throttle, one-report-per-outage) are fetched and reported again: the catalog on the next
  `unlock()`, `play()`, `music()` or `ambience()`, a file on the next call that needs it. Keeps loaded sounds, playback and the context — call it from
  a "toggle sound to try again" handler.

## Playing

- **`play(id, { pan, gainDb, cooldownSec, cap })`** → a handle `{ id, file, ready, stop(fadeSec?) }`,
  or **`null`**. It is `null` before `unlock()`, while hidden or disabled, for an unknown asset id,
  for an asset that loops (use `music`/`ambience` instead), when the voice budget has no less
  important voice to steal, or while the sound's own cooldown hasn't elapsed. `ready` is
  `Promise<boolean>` (true once actually sounding); it never rejects, even if the file fails to load
  or the Web Audio call throws — those report through `onError` instead.
- **`music(id | null, { fadeSec })`** / **`ambience(id | null, { fadeSec, slot })`** → `Promise<boolean>`:
  crossfades that bed to a new looping asset (or fades it out on `null`). Resolves once it plays,
  `false` if superseded by a later call, queued (before unlock or while hidden), or unavailable.
  Never rejects.
  `ambience` takes an optional `slot` (lowercase-dash name, up to 8 slots): each slot is an
  independent bed that crossfades alone, so a game layers a base bed, a weather bed and a biome
  undertone instead of baking every combination. No `slot` is the main bed; `ambience(null, { slot })`
  fades just that slot.
- **`setState(state, { fadeSec, at: 'now' | 'bar' })`** — fades the current music's adaptive layers to
  a named state (`asset.states[state]`). `at: 'bar'` waits for the asset's next bar line (needs
  `bpm`); default is immediate. With no music playing, or other music still loading, the state is
  kept and applied when that music starts (returns `false`, no error). It returns `false` and
  reports `E_NOT_ADAPTIVE` or `E_UNKNOWN_STATE` for music without layers or an undeclared state.
- **`setLevel(bus, value)`** — `bus` is `'music' | 'ambience' | 'sfx' | 'master'`; `value` is clamped
  to 0..1 and ramped in.

## Priority and voice stealing

An asset's `priority` follows the FMOD convention also used by
`meta.priority` and the kit: **1 is most important, 5 is least**. When the voice budget is full, a
new sound may steal only a voice whose priority number is *strictly larger* (less important); it
never drops the new request outright unless there is nothing to steal. A repeated sound with its own
instance cap (`cap`) replaces its own oldest instance first, before touching the shared budget.

## Inspecting

**`inspect()`** returns a snapshot for tests, debugging or a game's own UI:

```js
{ running, voices, levels: { music, ambience, sfx, master },
  music: { id, state, layers: { <name>: 0 | 1, ... } } | null,
  ambience: { id } | null, ambienceSlots: { <slot>: { id } } }
```

## Error codes (`onError`)

These are the player's own runtime codes, reported to `onError({ code, message, id? })` — distinct
from the CLI's `ErrorCode`s (`E_SCHEMA`, `E_USAGE`, ...), which never reach a game:

| code | means |
|---|---|
| `E_UNKNOWN_ASSET` | no asset with that id in the catalog |
| `E_NOT_SFX` | `play()` was called on a looping asset |
| `E_CATALOG` | the catalog could not be loaded (network, or not a valid `{ assets }` document); reported once per outage, see `retry()` |
| `E_LOAD` | one audio file failed to fetch or decode (`id` is the file path); tried twice, then silent until `retry()` |
| `E_PLAYBACK` | a Web Audio call threw while starting or running a sound |
| `E_CONTEXT` | the `AudioContext` could not be built, resumed or suspended |
| `E_USAGE` | `ambience()` was given an invalid slot name, or more than 8 slots (`id` is the slot) |
| `E_NOT_ADAPTIVE` | `setState()` was called on music with no `layers` |
| `E_UNKNOWN_STATE` | `setState()` named a state the asset does not declare (`id` is the state name) |

None of the player's public promises ever reject; failures always resolve (usually `false`/`null`)
and report through `onError` instead, so a game never needs a `.catch()` on player calls.

## The safety clipper

Every bus feeds one master `WaveShaper` (`clipperCurve()`, `engine/fx.js`) before the destination. It
passes signal through unchanged below its -1.5 dBFS knee and only gently rounds peaks above it — it
is a safety net for stacked voices, never a loudness effect, so levels are never suddenly clamped or
pumped by ordinary play.
