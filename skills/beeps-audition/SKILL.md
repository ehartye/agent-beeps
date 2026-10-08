---
name: beeps-audition
description: Put candidate sounds in front of the owner on a LAN listening page - seal your prediction, open the audition, wait for or hand off their lineup, duels and refine requests, breed new rounds, and ship the winner into the kit.
when_to_use: Use when a set of candidate sounds is ready for the owner to choose, when the owner wants to hear, compare, pick or refine sounds, after beeps generate or mutate, or when a command fails with E_PREDICTION_REQUIRED.
---

# Audition with the owner

For a sampler of **different roles** (a scanner, a shield, an alien), open with `--flow explore`.
This shows labeled playback pads without voting, duels, a winner, or a prediction requirement.
Give every patch a meaningful name and a short `meta.description` explaining its intended use.
The page displays both; generated seed/variant suffixes are omitted from the displayed name.
Use `--flow compare` (the default) only for alternatives competing for the **same role**.
Exploration needs no wait/refine loop; share its URL and let the owner listen.
A kit you authored by hand has no set yet: `beeps set create a.json b.json ... --prompt "..."` renders the
patches into one, then open it with `--flow explore`. (Songs and beds go to `beeps album open`.)

`beeps` means `node "<plugin-root>/scripts/run-managed.js"`. The owner listens on a page served to
the local network (`http://<this-host>:<port>/s/<id>?t=<token>`; port 47301 unless busy); they judge in
these comparison stages:
**lineup** (keep and dud), **duel** (A vs B, sides randomised, next pair chosen where the taste
model is least sure), **refine** (nudge the champion: brighter, darker, punchier, softer, shorter,
longer, less harsh, more character, more like #k, surprise) and **ship**. Only these explicit
choices become taste data; replays never count.

## 1. Predict first (sealed)

Look at the set's contact sheet and features, read `beeps taste show`, then commit:

```text
beeps predict --set <set-id> --pick 3 --shortlist 3,5 --why "short and dark, like their last coins"
```

The prediction stays hidden from the owner until they ship; the reveal scores you. Opening without
one needs `--no-predict`, which is recorded.

## 2. Open

```text
beeps audition open --set <set-id> --prompt "coin pickup for a cozy platformer" --mode live --context kit
```

`--context kit,bed` lets the owner play candidates around the project's shipped sounds and over a
soft pad. Give the owner the printed `url` exactly (it carries the token), plus `ipUrl` for phones that
cannot resolve the machine name. Never give a file path. `notes` says when the kit is still empty.

- **live** (default): you stay and answer refine requests yourself (step 3).
- **handoff**: the server breeds refine rounds on its own. Use it whenever you will not be waiting -
  the owner may listen later, or it is a batch - then end your turn. Next session, `beeps audition
  status --id <id>` shows the stage; once shipped it prints the `next` step to wire the sound in.

## 3. Wait and answer (live)

Run `beeps audition wait --id <id>` in the background (or Monitor its output). It returns the next
`refine`, `ship` or `abandon` event with a `todo` line.

On **refine**: breed toward what they asked, look at the sheet, and add the round:

```text
beeps mutate <champion-name> --toward darker,shorter --count 4      (add --like <name> for "more like #k")
beeps audition round --id <id> --set <new-set-id>
```

Then wait again. The owner sees the new round next to their champion.

## 4. Ship

On **ship** the champion is saved to `.agent-beeps/patches/` and added to the kit at its measured
trim. `beeps audition status --id <id>` shows the reveal: your pick, the taste model's pick, hit or
miss. Tell the owner in one line whether you called it, then wire the sound in (export a WAV or
play the patch through the engine) and run `beeps kit check`.

## Delivery formats (does the compressed file still sound right?)

`audition` and `album` play lossless WAV, so they cannot show what MP3 or Opus costs. Before choosing a
format or bitrate for a game, put the owner in front of the real encodes, blind, on their phone:

```text
beeps audition formats <bundle-dir | a.wav b.wav | --set <id> | --album <id>> [--presets wav,mp3-64,mp3-v5,opus-32,opus-48,anchor] [--catalog music=3600,sfx=400]
beeps audition formats-status --id <delivery>      (after the owner taps Reveal)
beeps taste import .agent-beeps/delivery/<delivery>/results.json
```

Needs ffmpeg like `beeps compress`. Give the owner `url` or an `ipUrls` entry (phones). They rate every
lettered version 1-5 and flag any that sound worse; one letter is the untouched WAV, one a 3.5 kHz
low-pass anchor. `formats-status` reports per role the smallest preset within half a point of the
original, whether the anchor screened the listening (an anchor rated above the original means the
ratings are unreliable), the device decode report, and real byte totals (`--catalog` projects them to
the whole library). Import logs one delivery preference per role and preset; it never changes the
sound taste model. No prediction is sealed for this mode (there is no lineup to call). Do not flip a
build default on one session: take the suggestion per role, then check the Safari row in the device report.

## Done bar

The owner shipped a sound (or closed the audition), you reported the reveal honestly, and the kit
check has no errors. `beeps audition stats` tracks how often agents and the model predict right.
