---
name: beeps-music
description: Compose game music with agent-beeps - beeps/song@1 songs (chord progressions, arps, bass lines, step drums, melodies, sections, mix moves) played by patch instruments, rendered to loopable, loudness-matched WAVs, linted against music craft rules, and put on a LAN album page for the owner.
when_to_use: Use when asked for music, a theme, a soundtrack, a music loop, background or level music, an ambient bed, a jingle longer than a few seconds, or "a track" for a game or app, when editing a beeps song or album, or when a beeps song or album command fails (E_SCHEMA with a pointer under /tracks, /patterns, /sections or /form).
---

# Compose music

`beeps` means `node "<plugin-root>/scripts/run-managed.js"`; run beeps-setup first if it is not
installed. Work from the project root (`beeps init` once). Songs are JSON documents in
`.agent-beeps/songs/`; `references/song-format.md` is the full format. `beeps song list` also shows
the bundled example songs: read one before writing your first.

You cannot hear. You can read the outline, the measured arc and sections, the lint, and **look** at
each song's look.png (section bands, waveform with the loudness arc in orange, spectrogram). The
owner's ear is the judge: finish with an album (step 6).

## 1. Plan before notes

Write down, for the piece: its job (exploration loop, menu, boss, sting), tempo, key and mode,
the form as named sections with bar counts, and **which parts play in which section**. Contrast
comes from the arrangement (parts entering, dropping out, changing register) more than from new
notes. For long-play music (exploration, menus) keep melody understated, leave space, and let the
loop end at the density it began with.

## 2. Pick instruments

`beeps instruments` lists the bundled patches (pads, bass, plucks, bells, leads, textures, drums)
with each one's root, where its layers sound relative to a written note (`osc -12` is an octave
below), and whether it holds for the note length or rings as a one-shot. A track's `instrument` is
a library name, a project patch name, or an inline patch. To make a new timbre, compose it as a
patch (beeps-compose skill), save it with `beeps new`, and name it.
Give each part its own register band. The `octave` argument sets where a chord or bass root lands:
bass at octave 2, pad chords at 4 (at 3 only for thin, filtered pads; `spread` drops the root one
octave further), arps and bells at 4-5, lead at 4-5, sparkle at 6. Parts that share a band need
rhythmic gaps between them.

## 3. Write, check, fix

- `beeps song new song.json` validates, saves, and prints the outline; `--force` replaces.
  Edit the saved file and run `beeps song check <name>` for the outline without rendering: every
  section's start time, and each track's note count, written `range` and `sounds` range with the
  instrument's layers included. Catch an octave slip or two parts in one band here.
- Errors are `E_SCHEMA` with a JSON `pointer` and a `hint`: fix exactly that field.
- Chords are symbols (`Dm9`, `Bbmaj7`, `C6/9`, `F#m7b5`, `Gsus4`, `C/E`) and are voice-led for
  you. Arps and bass lines read the same progression, so harmony stays consistent across parts.

## 4. Render, look, lint

`beeps song render <names...>` (several render in parallel) prints per song: length, played
loudness, loudness range, true peak, low-end share, stereo width, loop seam, each section's level
and brightness, and the lint. **Open every look.png.** Check that:

- The orange arc rises and falls where the plan says. Flat for minutes means sections do not differ.
- Sections that should thin out are visibly quieter or darker (per-section LUFS and Hz).
- The spectrogram bottom is not a solid bright band (a boomy bass); nothing piles up at one height.
- Register-band evidence compares held pitched notes that coincide, including instrument layer
  offsets and repeated sections. It omits unknown-duration one-shots, release/effect tails and
  instruments with no pitched layer (noise, grains, metal beds); use listening and stems to judge
  actual masking.
- Loop songs: the end looks like the start (seam under 3 dB).

Then run `beeps song stems <name>`: the mix hides a part that is 17 LU down. Every part you
wrote should be within about 15 LU of the mix. Fix every lint error, justify or fix every warning,
and work through each `judgementChecks` item. Levels are automatic (songs are trimmed to
`project.musicLoudness`, -20 LUFS by default): balance tracks with `gainDb`, never chase loudness.

## 5. Iterate by arrangement first

Find the culprit first: `beeps song render <name> --sections <name>` extracts the exact delivered
samples for every occurrence of those sections, preserving earlier automation, effects and mix
level. The first preview needs a full render; later previews reuse it. Output includes the source
render key and original time ranges. Preview loudness is intentionally not normalized again, and
whole-song lint is omitted. With `--only <track>`, it excerpts that part's full-length solo render
at the solo's level; use `song stems` when comparing parts at the full mix's trim.
Too busy: drop a part from a section or lower its `gainDb`. Muddy: move a part's octave,
drop a slash-chord bass from the pad, or lower the bass. Boring: vary which parts play per
section, add a `ramp` mix move (filter opening, a wetter reverb send, a 4-bar fade), change the
arp shape or rhythm. Reuse a tweaked instrument across tracks with the song's `instruments` block.
Harsh: lower the track `cutoff`. Repetitive melody: fewer notes, longer rests.

## 6. Hand to the owner

`beeps album open <songs...> --title "..."` prints the listening links before rendering, then stays
running while songs become playable individually. Share the link immediately; keep the command
running until it finishes. Stdout is one JSON result (`status: "rendering"`); stderr carries JSON
progress and final ready/failed counts. A failed song leaves the others playable and exits nonzero.
The owner can open the hostname or IP link from any device on the local network (never localhost).
The page streams each ready track, skips unavailable tracks, and records love / keep / dud, tags and
whole-track notes. **Note here** captures the current position before the owner types; saved moment
notes include the section and exact render identity. `beeps album feedback <id>` returns all notes.
Revise from the notes and open a new album; earlier albums retain their audio and feedback.

## Never

- Put a loudness literal anywhere: `gainDb` is balance between tracks only.
- Hand over a song you have not looked at, or a single take as "done" when the owner asked to choose.
- Ship bass notes below E1 or sections that exist only on paper (lint `song-register`, `song-unused`).

## Done bar

Every song renders with zero lint errors, you have looked at each look.png, and the owner has heard
the album (or explicitly waived it). Export with `beeps song export <name> --wav <path>`.
