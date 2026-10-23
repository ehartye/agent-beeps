# Worked examples

`beeps` means `node "<plugin-root>/scripts/run-managed.js"`. Each example is a complete run with the fields to read at each step. You cannot
hear: every judgement below comes from a number, a notice or a look image, and the owner's ear decides at the end (beeps-audition).

## 1. A UI chime for a notification

Brief: soft, short, two rising notes, under 400 ms.

```text
beeps init
beeps taste show
beeps generate confirm --count 4 --prompt "soft short notification chime"
```

Read in the result: `report` (`requested`, `kept`, `dropped`: a short set says so with `N_SHORT_SET`), `steering` (the prompt words it read: here `softer`,
`less-harsh`, `shorter`), `seed` (print it so the set can be asked for again), each candidate's `features` (`energyLengthSec`, `attackSec`,
`centroidHz`, `pitchHz` or `pitchReason`). **Open `sheet`** and look at the strips: two onsets, nothing ringing past the intended end.

```text
beeps lint confirm-985691-6 --brief
```

`errors` fail the command; `warnings` need a reason; a `notices` entry such as `N_SCALE_SNAP` says the render differs from the number in the patch (a
generated pitch the project scale moved). Then hold the sound still while the owner decides:

```text
beeps lint confirm-985691-6 --derive-expect      # prints derived.xExpect; paste it into the patch, tighten duration to 0.4
beeps predict --set <set-id> --pick 2 --shortlist 2,3 --why "shortest, no ring"
beeps audition open --set <set-id> --prompt "notification chime" --mode live --context kit
```

After the owner ships one: `beeps kit check` (every kit sound, with its `expectations` verdict).

## 2. An impact that must stay short

Brief: a punchy hit, never longer than 250 ms, however many times it is refined.

```text
beeps generate hit --count 6 --prompt "punchy short"
beeps lint <pick> --derive-expect            # paste the block, then change duration.max to 0.25 and tail.max to 0.1
beeps mutate <pick> --toward punchier --count 4
```

`mutate` checks each child against the parent's `xExpect`: read `report.dropped` (reason `expectation`) and `report.expectationMisses` (which kinds missed).
If everything is dropped the error says so and names `--ignore-expect`; do not pass it to get a longer sound, change the block if the brief changed.
Children do not carry the block: paste it into the one you keep. Compare a refined child with its parent as numbers and a picture with
`beeps diff <parent> <child>` (red is energy the child has more of), and once the sound is in the kit run `beeps kit golden bless` so a later engine or
toolchain change is judged by what it did to the sound: `beeps kit golden check` says identical, equivalent or different, with what moved.

## 3. A training-video bed

Brief: a quiet, unobtrusive loop under narration, a few minutes.

```text
beeps song list                                  # bundled songs; an ambient one is a good start
beeps song render outpost-dawn
```

Read: `length`, `loop` (true), `features.loudnessLufs` (the loudness it was trimmed to), `features.seamDb` (the loop seam, under about 3 dB is
clean), `loudnessRangeLu` (a bed should be low), `sections` (each section's level and brightness). A bed sits under a voice, so lower the music level for the
project: set `musicLoudness` in `.agent-beeps/project.json` (for example -26) and render again; the trim follows and `features.loudnessLufs` should read it.

```text
beeps song stems outpost-dawn                    # any part more than 15 LU under the mix is inaudible; silent parts are marked
beeps song export outpost-dawn --wav out/bed.wav --manifest
```

Open every `look` image first (the orange arc should be flat for a bed), then hand it over with `beeps album open outpost-dawn --title "bed"`.
