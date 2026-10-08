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
- **`music(id | null, { fadeSec })`** / **`ambience(id | null, { fadeSec, slot, gainDb })`** → `Promise<boolean>`:
  crossfades that bed to a new looping asset (or fades it out on `null`). Resolves once it plays,
  `false` if superseded by a later call, queued (before unlock or while hidden), or unavailable.
  Never rejects.
  `ambience` takes an optional `slot` (lowercase-dash name, up to 8 slots): each slot is an
  independent bed that crossfades alone, so a game layers a base bed, a weather bed and a biome
  undertone instead of baking every combination. No `slot` is the main bed; `ambience(null, { slot })`
  fades just that slot. `gainDb` (-60..12, default 0) sets a bed's level relative to the ambience bus,
  because every bed is exported at the same loudness: set the weather bed under the base bed here.
  Asking for the same bed again with a new `gainDb` ramps it over `fadeSec` without restarting.
- **`music(id, { fadeSec, at: 'bar', sync: true })`** — `at: 'bar'` starts the crossfade on the next bar line of the music
  playing (never mid-bar). `sync: true` starts the new loop at the phase the old one has reached when both have the same
  `bpm`, so beats and chords stay in step through the fade; plan loops of one tempo, key and a loop length that divides the
  others (`beeps song compat`). `inspect().music.positionSec` reads the position.
- **`play(id, { at: 'bar' })`** — a stinger that starts on the next bar line of the music playing (now when none plays).
- **`duck(bus | bus[], gainDb, { fadeSec })`** — turn a bus down on top of its `setLevel` volume and release it with `0`: dialogue and
  menus duck the music and ambience while the player's own volume setting is untouched. `inspect().ducks` shows them.
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

## Shipping small: `beeps compress`

Exports are WAV (10-15 MB per music loop). For a hosted web build run `beeps compress <wavDir> <outDir>`: every file becomes
Ogg Opus (music 56 kbps, ambience 48, sfx 72; override with `--music-kbps` etc.), sidecars become `*.ogg.json` with an `encoding`
block, and `<outDir>/index.json` is the catalog the player loads (the player decodes any format the browser does). The command
decodes every encoded file again and fails when the frame count changed, the decode does not line up with the source (music: 8 dB
or more; noise beds and sfx: loudness envelope correlation 0.8), or a loop's wrap now ticks (`seamExcessDb`: the energy of the
5 ms around the wrap against the loudest 5 ms elsewhere; +6 dB and 3 dB above the source fails). `beeps loopcheck <files>` runs
the frame and wrap checks on any encoded file, plus seam metrics (`seam`: `boundaryStepDb`, the last-to-first sample step in dB against
the file's typical sample step, where about 0 to 10 dB is clean and 20 or more ticks; `slopeJumpDb`; `lastZeroCrossingPhase`). With the
source WAV beside the file (or `--source <wav|dir>`) the source's seam is reported too and a delivered seam more than 3 dB worse
is a `warnings` entry, not a failure, since a loop may start on a transient by design (`beeps compress` reports the same per file; Opus
tends to smooth a seam, MP3 reproduces it). Song lint warns `song-loop-boundary-step` above 24 dB; add `--engines chromium,firefox,webkit` to decode it in real browsers with
`decodeAudioData` at 48000 and 44100 Hz and report the frame delta and start lead against the source (exit 1 on a delta; an engine
with no install or no Web Audio is reported as unavailable, never as a pass; `--require-engines` makes that a failure; install
engines with `node scripts/setup.js --browsers firefox,webkit`). Opus decodes to the exact frame count and loops gaplessly in Chromium and Firefox;
Safari is unmeasured. Needs ffmpeg with libopus (the optional `ffmpeg-static` dependency, `BEEPS_FFMPEG`, or the PATH).
