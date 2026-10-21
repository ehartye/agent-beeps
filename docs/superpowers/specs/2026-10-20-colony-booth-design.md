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

## Follow-ups from review

Four points were left open when the section first landed. Each is resolved on the same branch.

### 1. Separate status lines for pads and tracks

`#colony-status` served both the pads and the track buttons, so a pad pressed over a track replaced the
track's description. Pads get their own line, `#colony-pad-status`, directly under the pad grid. The
track line (`#colony-status`) is written only by track selection and track playback errors, so it keeps
describing the selected track however many pads are pressed. A load failure writes to both lines.

| Option | Time | Risk | Complexity | Best practice | Maintainability |
| --- | --- | --- | --- | --- | --- |
| Two lines (chosen) | Minutes: one element, one call site, two selectors in tests | Low; live regions stay polite and each line has one writer | Adds one element | One live region per control group | Each line has one writer |
| Restore the track text after each pad | Minutes | A restore races with a second pad and with a changed track | A save/restore pair of state | Weak: one region, two meanings | Fragile ordering |
| Leave it | None | Misleading text under an unchanged transport title | None | Poor | Known wart carried |

### 2. Look-image labels match the published recipes

The effect look images are labelled with the patch name, so they read `col-till` while the downloadable
recipe is `colony-till`. The render now builds each effect from the already-renamed patch, so the label,
the recipe and the live session patch share one name. Beds and songs are labelled with their titles and are
unaffected. The render is checked to leave every effect's audio unchanged (trim and measured features equal
the committed quality file); only the 9 effect look PNGs change.

| Option | Time | Risk | Complexity | Best practice | Maintainability |
| --- | --- | --- | --- | --- | --- |
| Render the renamed patch (chosen) | Minutes plus one re-render | Low if the name does not reach the audio; verified by comparing features | One line | Published artifacts agree with their labels | Nothing new to keep in sync |
| Rename the library patches to `colony-*` | Longer: library files, README tables, any tests naming them | Touches shipped library content and its docs | Wider diff | Right in the long run but outside this section | One name everywhere, at the cost of a library change |
| Leave it | None | None | None | Label and file disagree | A permanent mismatch |

### 3. Library-only instrument resolution for song renders

`resolveInstruments` reads a project's own `patches` folder before the bundled instruments. A developer's
same-named local patch would silently change a published render. The Colony render now passes a project
whose patches folder is a path that does not exist, so every named instrument resolves from the library.
Checked by planting a decoy local patch that shadows a library instrument the songs use and confirming the
re-rendered MP3s are byte-identical. Matter's score carries its instruments inline, so it has no exposure.

| Option | Time | Risk | Complexity | Best practice | Maintainability |
| --- | --- | --- | --- | --- | --- |
| Non-existent patches folder for the render (chosen) | Minutes | None to published bytes when no local patch exists | One derived project object | Reproducible renders from tracked inputs only | Local to the script |
| Fail the render if a shadowing local patch exists | Minutes | Blocks a developer who has a harmless local patch | A scan of every instrument name | Explicit, but noisy | Needs the resolver's search order duplicated |
| Add a "library only" flag to `resolveInstruments` | Longer: engine change, tests, docs | Touches code every song render uses | A new public option | Cleanest eventually | A flag for one caller |

### 4. The kit README's canopy warning

The kit README says the canopy bed's thin-low-end warning is intentional. The render raises no such warning.
The sentence is corrected to say what the lint reports (no warning on the canopy bed; the register diagnostics
paragraph stands). The song pitch warnings are a separate item: fixing them changes the renders and needs
a listen, so they stay on the backlog.
