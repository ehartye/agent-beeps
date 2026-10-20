# Colony kit on the listening booth

Put the bundled colony example kit (`library/sounds/colony-sfx`, `library/songs/colony-ambient`) on the
public listening booth (`showcase/`, published to GitHub Pages) so a visitor can hear the shipped examples
without installing anything.

## Scope

A new **Colony** section on the existing single page, after Fuse. It is a section, not a new page: the booth
is one page of stacked studies (Matter, sound bench, Touch, Flux, Fuse) sharing one transport, output
monitor and volume, and Colony joins that.

- **Nine effect pads**, synthesized live in the browser from their JSON recipes exactly as the sound bench
  and Flux do (no audio files): `till`, `plant`, `water`, `harvest`, `discovery`, `door`, `portal`, `repair`,
  `rest` from `library/sounds/colony-sfx/effects/`.
- **Seven rendered tracks**, encoded to MP3 as Matter is: the four ambience beds from
  `library/sounds/colony-sfx/environments/` (`glasshouse`, `canopy`, `interior`, `workshop`) and the three
  songs in `library/songs/colony-ambient/` (`outpost-dawn`, `the-underside`, `window-light`).

Out of scope: seamless-loop claims (like Matter, a repeat is a replay), changes to the library recipes, a
tabbed layout, new engine features, and any listening-approval claim (measured and visual validation only).

## Rendering

A new `scripts/render-colony.mjs` exports `renderColony(host, project)`, called from
`scripts/render-showcase.mjs` after the existing studies, in the style of `render-flux.mjs`.

- The kit is rendered against **its own** project settings (`library/sounds/colony-sfx/project.json`:
  D major pentatonic snap, -18 LUFS effects, -20 LUFS music), not the booth's `showcase/project.json`. The
  session file carries that scale and the page passes it to `buildPatch`, as Flux does with `study.scale`.
- Effects: seed 1, variant 0 (the kit README's export seed). Each gets a look image
  (`showcase/media/colony-<name>.png`), its measured `trimDb`, and its patch copied to
  `showcase/recipes/colony-<name>.json` (renamed `colony-<name>` so recipe names stay unique). Lint errors fail the render.
- Tracks: rendered with the song pipeline, encoded with ffmpeg (`libmp3lame -q:a 2`, 48 kHz, Xing header),
  decoded back and measured; a delivered true peak above -1 dBTP fails the render. Each gets a look image and
  its song recipe is copied to `showcase/recipes/colony-<name>.json`.
- Outputs: `showcase/media/colony-session.json` (schema `beeps/colony-kit@1`: `scale`, `effects[]`,
  `tracks[]` with title, kind `bed|song`, description, mp3 path, duration, integrated LUFS, true peak, look,
  recipe) and `showcase/media/colony-quality.json`.
- The manifest (`showcase/media/manifest.json`) additionally hashes the kit's library inputs
  (`library/sounds/colony-sfx/**`, `library/songs/colony-ambient/*.json`), so editing the library without
  re-rendering fails the site build.
- Size budget: all colony MP3s together stay under about 12 MB. If they do not, encode the songs with a lower
  quality setting and record why in the render script.

## Page

`showcase/index.html` gets a `<section class="sound-bench" id="colony">` in the same markup style as Flux and
Fuse (brand line, h2, badge, intro, pads container, status line, recipe links), with two groups:

1. **Effects**: nine pads (`#colony-pads`) using the same card as the other studies, registered in a
   `Colony effects` collection; each press builds the patch live.
2. **Beds and songs**: seven track buttons (`[data-colony-track]`) and one `<audio id="colony-audio" controls
   preload="none">`; choosing a track sets the source and plays it from the start. Registered in a
   `Colony music` collection.

`showcase/app.js` joins the shared transport: the Touch audio element's handling is generalized to a list of
background media (`audio`, `touch`, `colony`) wherever it is hard-coded (media-element graph wiring,
`stopAll`, `pauseShared`, `restoreMedia`, `resumeShared`, `draw`'s active check, the media event handlers,
foreground switching) so Colony behaves as Touch does: starting any one stops the others, the shared Play,
Pause, Stop, Esc, volume and output monitor work, and a foreground effect pad ducks the music. The meter label
reads `COLONY / BED` or `COLONY / SONG`. The intro paragraph mentions Colony. Existing sections must behave
exactly as before.

## Tests

- `scripts/test-showcase.mjs`: parse all nine patches, assert recipes in `_site/recipes` equal the library
  files, tracks have a finite duration, true peak <= -1 dBTP, a 206 byte-range response for each colony MP3, no
  autoplay, nine colony pads and seven colony tracks present, no 4xx/5xx responses, no page errors.
- `scripts/test-showcase-transport.mjs` / `-interactions.mjs`: add Colony cases mirroring the Touch ones
  (start a track, switch tracks, pad over a track ducks and restores, shared pause and resume, Stop, Esc).
- Existing Matter, bench, Touch, Flux and Fuse assertions pass unchanged.
- `tests/hygiene.test.ts` and the showcase manifest verification pass.

## Docs

`showcase/README.md` (what Colony is, how it is rendered, size), the root `README.md` (one line where the
booth and the library are described), `skills` untouched. Wiki: add to the booth reference and backlog.
