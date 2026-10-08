---
name: beeps-craft
description: Sound-design craft for procedural game and UI audio - which synthesis method suits which material, loudness and peaks, key, variation against listener fatigue, blend and masking in a kit, one "no" sound, priorities, and how to read measurements and look images.
when_to_use: Use when choosing how to build a sound, when a render looks or measures wrong (harsh, tinny, grating, too long, clicky, muddy, buried in the mix), when lint warns (sharpness-warn, roughness-warn, tail-ceiling, masking-risk, family-consistency), or when assembling a kit of sounds that must work together.
---

# Sound craft

The full guide with citations is `<plugin-root>/craft/GUIDE.md`; each rule lives in
`craft/rules.json` and `beeps lint` / `beeps kit check` enforce the automatic ones. Rules marked
judgement are listed on every run: apply them yourself, never skip them silently.

## Choose the method from the material

- Struck objects (wood, glass, bells, metal clanks, UI clicks): `modal` - a few resonant modes hit by
  an impulse or a short noise burst. Inharmonic ratios (2.76, 5.40, 8.93) read as bars and bells.
- Shakers, rain, gravel, debris, crackle: `grains` - Poisson-timed grains through a bandpass;
  `rateEnd` below 1 thins the texture out like settling debris.
- Bells, chimes, sustained realistic tones: `additive` partials, each with its own decay.
- Cymbals, hats, robots, anvils: `metal` (six inharmonic squares, two bandpasses; the envelope makes
  the instrument: 50 ms hat, 300 ms+ cymbal).
- Blips, coins, lasers, jumps, alarms: `osc` with pitch envelopes. FM for growl and bell-like bite.
- Animal and creature voices (yip, growl, bleat, moo, cluck, huff, hiss): `voice` - glottal pulses
  through 2-4 formant bandpasses. f0 contour from `pitchEnv`, size from the formants (small animal
  high, big animal low), roughness from `jitterCents` and low `tilt`, bleat and rasp from fast
  `vibrato`/`tremolo`, breath and hiss from `breath`. Start from `beeps generate creature`.
- Whooshes, impacts, rumble: `noise` through swept filters; layer a low sine thump for weight.
- Beds and ambiences that should feel wide (wind, rain, room tone): `stereo: true` on the `noise` or
  `grains` source decorrelates left from right with seeded noise. Mono noise measures width ~0 however
  it is panned. It costs mono compatibility only when both channels are summed (still equal power).

## Level, peaks, key

- Never set loudness in a patch. The renderer trims to the project target by family (UI quieter,
  impacts fuller). Very spiky sounds are trimmed only until their true peak reaches -1.5 dBTP and sit
  below target on purpose (`peakLimited`).
- Families the stock table does not know (footstep, foley, rustle) land at the full target, as loud
  as a strike. Set them under it in `.agent-beeps/project.json`:
  `"familyOffsets": {"footstep": -6, "foley": -4}` (LU against `targetLoudness`; an entry replaces
  the stock offset for that family), or give one patch `meta.loudnessOffsetDb`. Both default to
  nothing, so existing renders keep their keys; a moved sound's export sidecar carries
  `loudnessOffsetDb` (already in the samples).
- A gain value is not a loudness: a narrow bandpass passes a sliver of its source. Measure.
- Short, spiky sounds (a boom whose thump sets both the peak and the loudness) are often
  `peakLimited` (`render` and `measure` show it): the trim already stopped at the peak ceiling, so
  lowering the loudest layer can make the whole sound quieter. Lower the crest instead (a longer
  body, a softer spike), or accept the level.
- `no-dc` (an error): low sine or triangle thumps and lowpassed brown or pink noise leave DC. Fixes
  that work: a 45-50 Hz highpass on the thump, `bandpass` instead of `lowpass` on noise bodies, the
  thump at gainDb -4 to -5, or `fx.dcBlock: true` (a 10 Hz DC blocker on the layer mix). A short
  low burst (a 70 Hz sine decaying in 90 ms, lowpassed noise) has a nonzero mean by construction
  and needs its lowpass too: set the layer's `highpass` (40 Hz), a second filter after the
  envelope; lint names it per layer.
- Declare attacks of 4 ms or more (a linear 4 ms attack measures about 3 ms from 10 % to 90 %)
  unless the layer is quiet or the sound is meant to click (`meta.intent: "click"`).
- Pitched layers snap to the project scale (major pentatonic by default) so simultaneous sounds
  never clash. Keep a game's sounds in one key.

## Repetition and fatigue

Anything heard often (steps, blips, coins, hits) gets `variation` - 3+ variants or 20+ cents - with
`noRepeat`, or 3+ hand-made sibling patches (`<stem>-<n>` names or one `meta.variantOf`) when the
variants need different structure. Use `weights` to make a distinctive variant rarer. Audition it with the ×75 button.

## A kit is a system

- One "no" for the whole game: a soft falling figure, never a buzzer, so it is learned once.
- Same family, same character: coins should sound related (a recurring sound is a class label).
- Blend is a dial: dark and synchronized sounds fuse; bright, sharp ones stand out. Separate sounds
  that must be told apart by register and brightness (`masking-risk`).
- Priorities: at most five levels; the player's damage outranks a pickup in the same frame.
- If the player hears it, something happened. A tool with nothing to do is silent, not quiet.

## Reading a render

- `sharpness` (acum) high: tinny, scratchy; lower cutoffs or pitch. `roughness` (asper) high:
  grating, ~70 Hz beating; widen or remove close partials unless grit is intended (tag `gritty`).
- `flatness` near 1 is noise-like; `pitchStrength` near 1 is clearly pitched.
- In look.png, check the spectrogram for energy where you did not intend it (a stray tone is a
  horizontal line) and that the waveform ends when you meant. A vertical smear exactly at a pitch
  step is the analysis window straddling the change, not a click; a click is a smear at a sound
  edge with a jump in the waveform. `beeps lint` lists judgement rules with the text to apply.

Measurements are indicators, not verdicts. The owner's choices decide (beeps-audition).
