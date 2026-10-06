---
name: beeps-taste
description: Read and use the owner's learned sound taste - a Bradley-Terry model fitted from every lineup, duel and ship they made, global across projects with a per-project layer - and the record of how well agents predict their picks.
when_to_use: Use when writing an audition prediction, when asked what the owner likes in sounds, "what's my taste", "how often do agents guess right", or after several auditions to refresh the profile with beeps taste fit.
---

# The owner's taste

`beeps` means `node "<plugin-root>/scripts/run-managed.js"`.

Every explicit judgement in an audition (keep vs dud, a duel win, a both-bad) is appended to two
logs: `<project>/.agent-beeps/taste/verdicts.jsonl` and `~/.agent-beeps/taste/verdicts.jsonl`. The
model is always refit from those logs. Ties are logged but not fitted, because they bias the fit.

## Read it

```text
beeps taste show
```

- `preferences`: one entry per perceptual axis (energy length, attack, brightness, sharpness,
  roughness, fluctuation, noisiness, pitch strength, pitch direction, punch, register), with the
  preferred direction in words, a weight in feature-scale units, its standard error, and a
  confidence: `strong` (over 2 standard errors), `weak`, or `unknown`.
- `projectLayer`: true once the project has 15 or more pairwise judgements. Below that the global
  taste applies, so a new game starts from what the owner likes everywhere.

Apply `strong` preferences when you write or pick candidates. Treat `weak` as a tie-breaker and
`unknown` as open: vary those axes on purpose so the owner's next choices teach the model.

`beeps taste fit` writes `model.json` and a readable `summary.md` next to the log.

## Feed it from a game's own listening page

A game can ship a page where the owner clicks through every sound it makes and gives thumbs, level
votes and notes (Fallow Valley's `tools/build-audition.mjs`). It exports
`{ "schema": "<game>/audition-feedback@1", "patchDir": "asset-src/audio/sfx", "items": [{ "name", "rating": "up"|"down"|null, "level", "note" }] }`.
Run, in the beeps project folder:

```text
beeps taste import feedback.json [--patches <dir of <name>.json patches>] [--dry-run]
```

Each rated patch is rendered and measured, then paired like a lineup: within a family every liked
sound beats every disliked one (`implied`, weight 1/3); a disliked sound with nothing liked beside
it is a `bothBad` row. Likes with nothing to compare against, sounds with no patch file and the
level votes are reported, not logged. Level votes and notes are about the mix, not the sound: apply
them to the game's mix table yourself. Run `beeps taste fit` afterwards.

## Predict and be scored

`beeps generate` already ranks by this model, and every audition records the model's own sealed
pick next to yours. `beeps audition stats` (or `beeps taste stats`) reports hit rates: your top
pick, your shortlist, and the model's pick, overall and over the last 10 sessions. When the model
beats you, lean on it; when you beat it, say what you noticed that its features do not capture.

## Limits

The features are measurements of the sound, not of the owner. The model learns what they chose
among what they were shown, within a family's typical spread. It cannot know what nobody offered.
Never present the profile as the owner's opinion; quote it as "your past choices lean ...".
