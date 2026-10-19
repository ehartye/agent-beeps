# Fuse — recorded contact, designed body

A short metal recording supplies irregular attack detail. Modal resonances add weight, a shaped
FM index folds the resonance inward, and thinning stereo grains lead into a small room.
The three takes are individually leveled to the same measured max-momentary loudness.
The hybrid's relative layer balance differs from solo playback; the solos are listening studies,
not stems to sum at their comparison levels. Playback uses measured runtime cues in the public booth.
The contact's measured 1 ms rise is intentional (`meta.intent: "click"`). Its PCM preparation has
a 96-frame fade in and 960-frame fade out; a DC blocker removes offset without replacing that contact
with a slow envelope. The designed body starts 12 ms later, leaving the first impact to the recording.

The recording is Kenney's `Audio/impactMetal_heavy_000.ogg` from **Impact Sounds 1.0**,
[CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/).
[Official source](https://kenney.nl/assets/impact-sounds). `LICENSE.txt` is the pack's exact included
license; `provenance.json` identifies the original, archive, decoder and normalized snapshot.
Procedural patches and preparation recipes are also dedicated to CC0 for this example.
No private recording, original compressed audio, machine path or import receipt is included.
Signal checks do not establish listening preference; owner listening is pending.

## Use with the ordinary CLI

With Node 24+ and an installed agent-beeps checkout, initialize a project (or use an existing one):

```sh
node /path/to/agent-beeps/scripts/beeps.mjs init
node /path/to/agent-beeps/scripts/beeps.mjs sample sync /path/to/fuse/prepared-bundle
node /path/to/agent-beeps/scripts/beeps.mjs render fuse-hybrid
node /path/to/agent-beeps/scripts/beeps.mjs look fuse-hybrid
```

In a downloaded archive, the strict source bundle is named `bundle`, so use `sample sync ./bundle`.
`README.md`, `LICENSE.txt` and `provenance.json` belong beside that strict bundle, not inside it.
The **prepared** archive carries the three patches and just their prepared WAV dependency.
The explicitly labeled **preparation** archive additionally carries the normalized source snapshot
and saved preparation receipt. It contains the complete short recording, including its untrimmed edges.
To replay it without the original OGG or an authoring machine:

```sh
node /path/to/agent-beeps/scripts/beeps.mjs sample sync /path/to/fuse/preparation-bundle
node /path/to/agent-beeps/scripts/beeps.mjs sample prepare --recipe /path/to/fuse/preparation-bundle/recipes/3d48429387356158c36c9e320d02f2fa1d4565beed7d59e03a1350ad9cde6357.json
```

In a downloaded archive replace `preparation-bundle` with `bundle`. The receipt records exact integer
frame controls and the expected output identity. Replay must reproduce that identity.
Changing a patch's procedural layers requires no external sound editor. Source-only and hybrid
patches need their sample bundle; a lone patch JSON is not a portable recording.

## Reproduce the booth

From the repository, `node scripts/compose-fuse.mjs` restores the public preparation bundle into
the ordinary local store and writes the authored study patches. `npm run showcase:render` measures
and exports cues, images, quality reports and deterministic downloadable archives through the
production APIs. `npm run showcase:build` verifies all committed source/media hashes before copying.
The booth's Stop, Escape, volume and single-voice behavior apply to all three takes.
