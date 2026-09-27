# agent-beeps game runtime and adaptive layers

**Status:** the owner approved this design on 2026-09-27. It is not built yet.

This is sub-project 1 of the delivery work that v1 deferred. The v1 spec (`2026-09-25-agent-beeps-v1-design.md`) listed it as "delivery (game runtime API polish, sound sprites, OGG, engine exports)". On the same day the owner also brought adaptive music layers into scope, and they ship in this runtime.

## Why

Games use agent-beeps output as rendered files. Space to Grow's `src/audio.mjs` in room2grow is 83 lines, and it had to hand-build all of the following:

- a voice budget
- retrigger cooldowns
- a master limiter
- bus levels
- 2-second music crossfades
- a serialized suspend/resume queue, which only worked after a lifecycle bug fix

Every future game would rebuild the same thing.

Space to Grow also used a `DynamicsCompressor` as its limiter. In the v1 measurements, that node shifted level by 1 to 3 dB even when the signal was 40 dB below its threshold.

Most of the owner's games run in the browser (Phaser, React/Vite, three.js), so a Web Audio runtime covers them. The one Unity project keeps using file exports and their manifests.

## How the delivery spec splits up

Each sub-project gets its own spec, plan and build. The owner chose this order:

1. **Game runtime** (this document): the player module, the voice manager, buses and mix protection, music and ambience crossfades, and adaptive vertical layers.
2. **Asset packaging:** OGG output and sound sprites.
3. **Engine exports:** live synthesis of patch JSON inside games.

## Decisions

- **The runtime plays rendered files only.** A game plays exactly the audio the owner auditioned, at its measured levels. Live synthesis is sub-project 3.
- **Adaptive music starts with vertical layering.** Collins calls this "variable mixing": the stems of one loop fade in and out with the game state. Horizontal re-sequencing ("variable form") comes later, informed by what we learn here.
- **The runtime is a dependency-free ES module that agent-beeps ships and games vendor.** Two alternatives were rejected:
  - Wrapping Howler.js: its voice pool would fight ours, and priority, layers and mix protection would still be custom code.
  - Generating audio code per game: every game would rediscover the same bugs.

## Components

### Player module: `runtime/player/player.js`

This is a single browser-only ES module. Its only imports are two engine files: `clipperCurve` from `fx.js` and `createPicker` from `variation.js`.

`beeps player export <dir>` writes it to `<dir>/beeps-player.js` as one file, with the engine imports inlined. A header names the plugin version and the engine version. Games import their vendored copy, so a plugin update never silently changes a shipped game.

```js
const player = createPlayer({ catalog: '/audio/index.json', voices: 8, onError })
await player.unlock()                        // on a user gesture; queued music/ambience starts here
player.play('coin', { pan, gainDb })         // -> handle | null (dropped by the voice manager)
player.music('sproutpost', { fadeSec: 2 })   // crossfade on the music bus; a null id fades out
player.ambience('garden', { fadeSec: 2 })
player.setState('danger', { fadeSec: 1.5, at: 'now' | 'bar' })
player.setLevel('music' | 'ambience' | 'sfx' | 'master', 0..1)
player.setHidden(bool); player.setEnabled(bool); player.stopAll()
```

`createPlayer` also accepts:

- `context`: an existing `AudioContext`
- `fetcher`: a fetch replacement, for tests

`catalog` can also be an object instead of a URL.

### Catalog: `beeps bundle <dir>`

`beeps bundle <dir>` collects every `beeps/audio-asset@1` sidecar in `<dir>` into `<dir>/index.json`:

```json
{ "schema": "beeps/audio-bundle@1", "assets": { "<id>": <manifest> } }
```

Two sidecars with the same id are an error, and the error names both files.

The asset manifest gains these optional fields. They are additive, so existing sidecars stay valid.

| Field | For | Meaning |
|---|---|---|
| `priority` | sfx | 1-5, from the patch's `meta.priority` (default 3) |
| `variants` | sfx | `[{ file, weight? }]`: several rendered takes of one sound |
| `noRepeat` | sfx | from the patch's `variation.noRepeat` |
| `bpm`, `meter` | music | for bar-quantized state changes |
| `layers`, `states`, `initialState` | music | adaptive layers (see below) |

`beeps export <patch> --variants [n] --manifest` renders variants 0 to n-1 as `<name>.<i>.wav` and writes one sidecar that lists them. `n` defaults to the patch's `variation.variants`. The existing `--variant <i>` export of a single take does not change.

### Voice manager (SFX bus)

- **Budget:** at most `voices` SFX play at once (default 8).
- **Stealing:** when the budget is full, a new sound takes the slot of the oldest *less important* voice, fading that voice out over 20 ms. Priority 1 is the most important and 5 the least, the FMOD convention used by `meta.priority` and the kit, so the victim's number must be strictly larger. If no voice is less important, the new sound is dropped and `play` returns null.
- **Priority is one-way:** a lower-priority sound never displaces a higher one. So the player's damage sound beats a pickup in the same frame, as the craft rule requires.
- **Retrigger limits:** each sound has a cooldown (default 50 ms) and an instance cap (default 3). Both can be overridden per call and per asset.
- **Variant choice:** the engine's `createPicker` chooses variants, using the manifest's weights and `noRepeat`. The picker takes a patch, so the runtime passes it `{ variation: { variants, weights, noRepeat } }` built from the manifest. Repeats therefore behave as they do under the audition page's ×75 button.
- **Structure:** the manager is a pure object with an injected clock. The audio side is a thin adapter over it.

### Buses and mix protection

The signal chain is:

1. Music, ambience and SFX buses, each with its own gain.
2. A master gain.
3. The engine's safety clipper, with the same curve the renderer uses.
4. The destination.

The clipper's behavior:

- Below -1.5 dBFS it passes the signal through unchanged, bit for bit. So it never changes the level of anything that is not peaking.
- Above -1.5 dBFS it curves smoothly toward a -1 dBFS ceiling.
- When coincident voices do clip, the clipped part aliases. That is audible only on a real overload, and the voice budget makes those rare.

This trade is deliberate: a compressor would move the approved levels all the time in order to handle a rare event. Every level change uses a ramp of at least 20 ms, so nothing clicks.

### Adaptive vertical layers

**Authoring.** The song schema gains an optional `adaptive` block:

```json
"adaptive": {
  "layers": { "bed": ["pad", "bass"], "pulse": ["arp", "hat"], "threat": ["drums", "lead"] },
  "states": { "calm": ["bed"], "explore": ["bed", "pulse"], "danger": ["bed", "pulse", "threat"] },
  "initial": "explore"
}
```

Validation rules:

- Every track belongs to exactly one layer.
- States may name only existing layers.
- `initial` must be one of the states.
- `adaptive` requires `loop: true`.

A new judgement check tells the author that every state must also work musically on its own.

`beeps song render`, albums, lint and audition keep working on the full mix, unchanged.

**Export.** `beeps song export <name> --layers <dir> --manifest` renders each layer as a solo of its tracks:

- Each layer is loop-folded. Solo renders currently force `loop: false`, so the solo path needs a keep-loop option.
- Each layer uses the full mix's trim, not its own, so the layers add up to the mix.
- The output is one `<name>.<layer>.wav` per layer, plus a single sidecar holding `layers`, `states`, `initialState`, `bpm` and `meter`.

**Runtime.** Calling `music(id)` on an adaptive asset starts every layer's buffer at the same context time, with `loop = true`. The buffers are the same length and run on one clock, so they stay sample-aligned.

`setState` ramps each layer's gain to 1 or 0 over `fadeSec`:

- `at: 'now'` starts the ramp immediately.
- `at: 'bar'` starts it at the next bar line, computed from `bpm`, `meter` and the start time.

On music that is not adaptive, `setState` does nothing and warns once.

## Error handling

The runtime never throws into the game loop. Every problem is reported through `onError({ code, message, id })`.

- **Unknown asset or state:** warns once per id and returns null.
- **Failed load or decode:** that asset stays silent, and the next call retries once. If one layer's file is missing, only that layer goes silent.
- **Calls before `unlock`:** SFX are dropped, so unlocking does not release a burst of stale sounds. Music and ambience are queued, and the last request wins.
- **Lifecycle:** unlock, hide/show and enable/disable all go through one serialized queue, so rapid toggling cannot leave the context suspended.
- **Stale scenes:** a request token stops a slow download for an old scene from starting its loop after a newer request.

## Testing

**Unit tests** (vitest, no audio):

- the voice manager: budget, strict-priority stealing, dropping, cooldown, instance cap, and weighted no-repeat picks
- the bar-quantization timing math
- the lifecycle queue under rapid toggles
- catalog and bundle validation, including the duplicate-id error

**Schema tests:** validation of the `adaptive` block, including the lint that each track is in exactly one layer.

**Browser tests** (Playwright in Chromium):

- A small bundle plays through the vendored player. A test probe reports voice counts and the gain values of buses and layers, and the tests assert on those.
- The clipper passes signals below its knee through bit-exact.

**Offline null test:** render an adaptive song's layers, sum them, and compare the sum with the full mix. The difference must stay below -60 dB relative to the mix. This proves that layering does not alter the approved mix. It also catches the case where the clipper engaged on the full mix but not on the separate layers.

**Acceptance:** a room2grow PR replaces Space to Grow's `audio.mjs` with the vendored player. It passes when:

- the settings behave as before: Off, Soft, Medium or Full per bus, off by default
- the scenes and the 2-second transitions are unchanged
- the owner hears no difference when listening
- the game's tests pass

## Out of scope

- OGG and sound sprites (sub-project 2)
- live synthesis (sub-project 3)
- horizontal re-sequencing
- ducking
- spatial and 3D audio
- a music taste model

## Risks

- **A new public API that games vendor.** Vendoring lets each game choose when to update, and the header records the version. A breaking change requires a new major version.
- **Loop-folded layer tails.** Reverb and delay tails fold separately in each layer. The null test proves the layers still add up to the mix.
- **Clipper aliasing on real overloads.** This is accepted and documented, and the voice budget keeps overloads rare.

## Amendments made while planning (2026-09-27)

1. The player is vendored as a directory, `<dir>/beeps-player/{player,engine}/*.js`, which keeps
   the runtime's relative imports. It is not a single inlined file. No bundler is needed and names
   cannot collide. The header and `VERSION.json` record the versions.
2. `song export --layers` is a flag. Layer WAVs are written next to `--wav` as `<stem>.<layer>.wav`.
3. `song stems` already renders loop-folded solos at the mix trim, and layers reuse that path.
4. The player uses catalog keys as asset ids and accepts any `{ assets: {...} }` object, including
   hand-built game manifests whose keys differ from the sidecar ids.
5. The per-sound instance cap replaces that sound's oldest instance rather than dropping the new
   request.
