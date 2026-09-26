---
name: beeps-music
description: Compose game music with agent-beeps - write a beeps/song@1 JSON (chord progressions, arps, bass lines, step drums, melodies, sections, mix moves) that plays library or project patches as instruments, then check, render, look at, lint and export loopable, loudness-matched WAVs and put them on a LAN listening page.
when_to_use: Use when asked for music, a theme, a soundtrack, a loop, background or level music, an ambient bed, a jingle longer than a few seconds, or "a track" for a game or app, when editing a beeps song, or when a song command fails with E_SCHEMA and a pointer.
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

`beeps instruments` lists the bundled patches (pads, bass, plucks, bells, leads, textures, drums).
A track's `instrument` is a library name, a project patch name, or an inline patch. To make a new
timbre, compose it as a patch (beeps-compose skill), save it with `beeps new`, and name it.
Give each part its own register band: sub/bass (octave 1-2), pads (3-4), arps and bells (4-5),
lead (4-6), sparkle (6). Parts that share a band need rhythmic gaps between them.

## 3. Write, check, fix

- `beeps song new song.json` validates, saves, and prints the outline; `--force` replaces.
  Edit the saved file and run `beeps song check <name>` for the outline without rendering: every
  section's start time and each track's note count and range (catch an octave slip here).
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
- Loop songs: the end looks like the start (seam under 3 dB).

Fix every lint error; justify or fix every warning; apply the judgement rules
(`song-register-bands`, `song-fatigue`). Levels are automatic (songs are trimmed to
`project.musicLoudness`, -20 LUFS by default): balance tracks with `gainDb`, never chase loudness.

## 5. Iterate by arrangement first

Too busy: drop a part from a section or lower its `gainDb`. Muddy: move a part's octave, thin
the pad voicing (`voicing: "spread"`), or lower the bass. Boring: vary which parts play per
section, add a `ramp` mix move (filter opening, a fade-in), change the arp shape or rhythm.
Harsh: lower the track `cutoff`. Repetitive melody: fewer notes, longer rests.

## 6. Hand to the owner

`beeps album open <songs...> --title "..."` renders anything stale and prints links the owner opens
from any device on the local network (a hostname link and an IP link; never localhost). The page
streams each track, loops loop songs, and records love / keep / dud, tags and notes per track.
`beeps album feedback <id>` returns them. Revise from the notes, re-render, and reopen the album.

## Never

- Put a loudness literal anywhere: `gainDb` is balance between tracks only.
- Hand over a song you have not looked at, or a single take as "done" when the owner asked to choose.
- Ship bass notes below E1 or sections that exist only on paper (lint `song-register`, `song-unused`).

## Done bar

Every song renders with zero lint errors, you have looked at each look.png, and the owner has heard
the album (or explicitly waived it). Export with `beeps song export <name> --wav <path>`.
