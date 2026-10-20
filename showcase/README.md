# Matter — the public listening booth

[Play Matter](https://ehartye.github.io/agent-beeps/)

An original 48-bar score at 128 BPM: 90 seconds of form plus the natural release and effects tail
(94.365 seconds delivered). Nine scenes connect glass, broken-beat electronics, a double-tracked
mechanical riff and a formant choir. Thirteen parts use twelve instrument recipes and all eight
engine source types. Six effect pads come from the approved sci-fi library; Subterranean adapts
the creature-growl archetype and Titanium Rain is a new metal/grains patch. Further down the page,
Touch, Flux, Fuse and Colony are shorter studies that share the same transport.

The page reuses `runtime/audition/style.css` and `album.css` verbatim: the actual booth's palette,
typography, pads, transport and loudness-strip design. Its public controller is separate from the
local audition app because Pages has no voting API, project token or event store. It collects no
feedback or listening history. Google Fonts is the existing stylesheet's only external asset service;
the CSS includes local fallback fonts.

## Run and publish

Node 24+, `npm ci --ignore-scripts`, then:

```sh
npm run showcase:build
npm run showcase:serve
```

Open `http://localhost:47320` (or the host's name on the LAN). The preview server supports
MP3 byte ranges; the renderer's minimal static server doesn't. `PORT` overrides 47320.

The `.github/workflows/pages.yml` workflow validates a project-path build in Chromium on pull
requests and publishes `_site` after a push to `main`. Repository Settings → Pages → Source must
be **GitHub Actions**. The deploy job has only `pages: write` and `id-token: write` beyond read-only
contents. No tokens, `.agent-beeps` state, node modules or source WAVs are published.

## Revise the audio

`scripts/compose-showcase.mjs` is the authored arrangement; it writes `recipes/matter.json`.
It also runs `scripts/compose-expression.mjs`, which writes the Touch library song and both A/B recipes.
`scripts/compose-flux.mjs` writes the six Flux library patches and downloadable comparison recipes.
Edit that script and run `npm run showcase:compose`, or edit the JSON directly and skip composition.
`showcase/project.json` pins the render settings independently of a developer's local project.

```sh
npm run showcase:compose
npx playwright install chromium
npm rebuild ffmpeg-static
npm run showcase:render
node scripts/beeps.mjs song stems showcase/recipes/matter.json
npm run showcase:build
npm run showcase:test
```

Rendering reuses the normal measured song/patch pipelines and their cache. It uses ffmpeg-static
(or `BEEPS_FFMPEG`) to encode VBR MP3 and measures the decoded delivery file, rejecting peaks
above −1 dBTP. MP3 allows streaming on current browsers and older Safari without loading an entire
PCM score into memory. This is a one-shot reel; repeat is a replay, not a seamless-loop claim.

The committed `media/manifest.json` verifies recipes, render settings, audio, measurements, images
and the engine JavaScript. Ordinary builds do not rerender audio. Changing any of those inputs
requires an explicit render before the site can build; hosted CI therefore needs no encoder.

## Playback and checks

The reel is a single HTML audio element routed into Web Audio. Each pad constructs `buildPatch`
with its measured trim, exact seed and scale. Pads are monophonic: a new strike disposes the old
voice. Music ducks during the effect, then returns smoothly. Both paths pass through the shared
safety curve and master volume. Stop and Escape dispose the effect and reset the reel. Space
controls playback outside interactive controls; 1–8 strike pads. The seek strip supports arrows,
Home and End. No audio starts without a gesture. Reduced-motion preference disables continuous
spectrum animation; visibility changes stop offscreen drawing.

`npm run showcase:test` serves the built site under `/agent-beeps/`, tests desktop and 390px mobile
layouts, transport, chapter seek, keyboard seek, stop, repeat and failed-manifest UI. It plays every
pad and also renders each through an OfflineAudioContext to assert finite, nonzero, sub-full-scale
samples. It fails on page exceptions or missing local assets. Screenshots go into ignored
`.agent-beeps/showcase-review/`.

## Mix review

The final decoded MP3 measures −24.34 LUFS integrated and −1.69 dBTP, with an 8.1 LU loudness range.
Low-frequency energy share is 25.6%, reduced from the first mix's 55.2%. Final stems sit 2.5–9.6 LU
below the full mix; the initially buried air, grains and metal hats are now represented. Full
machine reports are in `media/quality.json`; the displayed orange arc comes from measured sections,
and the live frequency monitor samples the actual post-volume output.

Zero song or patch lint errors. The remaining warnings are reviewed, not suppressed:

- **Song loudness target:** the score is peak-limited below the project target. Preserve the
  transient contrast and deliberate quiet scenes instead of pushing it into the safety curve.
- **Written pitch:** glass, FM keys, silk and choir span more than an octave from their patch roots.
  Retuning is intentional. The choir's formants remain fixed while its fundamental follows the notes.
- **Titanium Rain sharpness:** 2.77 acum exceeds the 2.2 warning threshold. It is an isolated bright
  metallic/debris effect, not a repeated bed; its fixed measured trim and single-voice playback remain.
- **Register checks:** the two iron parts deliberately double one riff, separated by stereo placement
  and seeded timing. Keys leave rhythmic gaps under glass. Silk sits behind choir as harmonic support
  in Bloom; glass occupies the upper register. Vacuum and Afterglow have few notes and long spaces.
- **Fatigue:** this is a short changing showcase, not an exploration loop. Repeat is off by default.

These checks establish signal health and arrangement evidence. They do not establish human listening
approval or acoustic realism. The owner remains the judge by ear.

Project architecture and roadmap are maintained in the agent-beeps wiki.

## Touch: an expression study

[Compare the takes](https://ehartye.github.io/agent-beeps/#touch). Eight bars at 92 BPM, 23.94 seconds
including release and room tails. The plain take is derived from the expressive score with the
lead's curves and `velocityInput` removed; pitches, velocities, timing, backing and instruments
are identical. Both use the same rendering engine. The single player preserves position and
pause state when switching, and shares the booth's volume and spectrum monitor.
The composer embeds the four stock backing instruments as patch snapshots, so the downloads
keep the same sound even when a recipient has local overrides or a different library version.

`scripts/render-expression.mjs` runs inside `showcase:render`, reuses the measured song pipeline,
then matches both deliveries to a common attainable loudness before encoding. Decoded MP3s are
within 0.01 LU, about −21 LUFS integrated, with peaks below −8.8 dBTP. Exact results and looks live
in `media/touch-quality.json` and `media/touch*.png`. The peak ceiling and 0.2 LU matching tolerance
are enforced on every render; the website tests also verify byte-range seeking and take switching.

No lint errors. The keys span F3–E5 and the sine bass A1–D3, intentionally crossing the one-octave
retuning warning threshold of their library patches. These are continuously tuned FM/oscillator
instruments. Register-overlap checks remain listening prompts: the short, offbeat key voicings
leave room under the longer lead gestures; bass fills briefly touch the keys' lower register.
Signal checks and the spectrogram do not establish musical preference. Owner listening is pending.

## Flux: an FM timbre study

[Compare the live patches](https://ehartye.github.io/agent-beeps/#flux). Alloy, Arc and Pulse core
each compare a static modulator index against a breakpoint index envelope. Within a pair, the
oscillators, pitch, amp, effects and seed are identical; only the index curve and measured playback
trim differ. The shaped take's waveform and spectrum appear on the card. Both recipes are downloadable.

`scripts/render-flux.mjs` runs inside `showcase:render`. It measures the normal patch render, then
renders both takes again at a common max-momentary target of −22 LUFS (or lower if necessary).
The matching tolerance is 0.2 LU and the ceiling is −1 dBTP. The comparison target is explicit in
`media/flux-quality.json`; lint and preview images use the actual comparison delivery. These are
short effects, so matching uses max-momentary loudness rather than integrated loudness.

All six patches are synthesized live through the existing engine, master volume and safety curve.
New strikes replace the previous voice; Stop and Escape dispose it. Browser checks play all six
takes and render them offline to verify finite, nonzero signals and audible-signal differences.
The study demonstrates timbre automation; it makes no physical-material or listening-approval claim.

Engine capability version 3 requires rebuilding older audio locks/cues. The envelope module is
included in the site's verified dependency manifest. Existing recipes without envelopes retain
their previous synthesis behavior.

## Colony: a worked example kit

[Hear the kit](https://ehartye.github.io/agent-beeps/#colony). The page plays the bundled example kit in
`library/sounds/colony-sfx/` and `library/songs/colony-ambient/`: nine effect pads and seven tracks
(four ambience beds and three songs).

- **Effects** are synthesized live in the browser from the library recipes, exactly as the sound bench
  does. No effect audio files are published. Each card links its patch, published as
  `recipes/colony-<name>.json` (the render renames the patch so recipe names stay unique; the library
  files are not modified). A strike ducks the playing track and returns it afterwards.
- **Tracks** are rendered MP3s (`media/colony-<name>.mp3`, about 5 MB in total) played through the
  shared transport, so Play, Pause, Stop, Escape, volume and the spectrum monitor work as for Matter,
  and starting a track stops any other music. The meter reads `COLONY / BED` or `COLONY / SONG`.
  Choosing a track plays it from the start; a repeat is a replay, not a seamless-loop claim.
- **Settings:** the kit renders against its own project (`library/sounds/colony-sfx/project.json`: its
  scale and its effect and music loudness targets), not `showcase/project.json`. The session file
  `media/colony-session.json` carries that scale and the page passes it to the live patches.

`scripts/render-colony.mjs` runs inside `showcase:render`. It rejects lint errors and any delivered
true peak above −1 dBTP; measurements and looks are in `media/colony-quality.json` and
`media/colony-*.png`. The manifest hashes the kit's library inputs, so editing anything under
`library/sounds/colony-sfx/` or `library/songs/colony-ambient/` fails the build until you run
`npm run showcase:render`. The website tests check the nine patches, that each published recipe equals its
library file, durations, peaks, loudness against the kit target, byte ranges and the transport cases. As
with the other studies, these are signal and structure checks, not a claim of listening approval.
