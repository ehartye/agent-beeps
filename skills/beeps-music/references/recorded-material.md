# Places and kits from recordings

Lessons from composing ambience scenes and music whose instruments are recordings, in the order they were learned. Each says
what was measured and what only a listener decided: measurements are not a listening verdict. The mechanics (import, prepare,
crop, bundle) are in [hybrid sources](../../beeps-compose/references/hybrid-sources.md); a song plays a prepared recording through
a [fixed sample instrument](song-format.md).

## 1. A place is events with gaps, not a bed

- **Give a scene a form.** A 48 to 64 second scene worked as arrival, signs of life, an incursion, an aftermath. The thing that
  would be the obvious loop (distant fighting, a passing engine) is one event inside the place, heard once or twice.
- **A long or repeated recording becomes the place.** A fan, a motor or a chorus of insects that runs through a scene was heard as
  the scene's whole character, and rejected where that character was wrong. Use it briefly, or as one event.
- **Do not share one air layer between places.** One grain-cloud "air" under four different scenes was heard as constant rain on a
  tin roof in all of them. A low correlation between two-second windows had not made it sound like wind: that check is too narrow
  to predict what a continuous texture reads as. Removing the layer entirely, leaving separate events and silence, was the
  comparison that let the rest be judged.
- **Start with an event, and leave deliberate gaps.** An early first cue tells the listener where they are; pauses between
  place-specific events do more for a sense of space than a filled background.
- **Check the fiction against the material.** A treatment can be technically clean and still say the wrong thing: a liquid
  treatment on a place that is dry, a tropical chorus where nothing is meant to be alive. Write down what each place is and is not before choosing
  recordings.
- **Say what is invented.** A sound designed for a creature or machine that does not exist is contact design from its described
  behaviour, not a recording of anything; record that beside the cue.

## 2. Recordings as a kit

- **Sort by attack, then give roles.** Door slams and heavy contacts take the kick's place, short mechanical clicks the backbeat
  and ghost notes, starter cuts and small clicks the clock. Six different acceleration attacks can supply every drum role.
- **Recordings keep their speed and pitch.** A sample instrument track is `fixed`. Filters, gates, timing, velocity, stereo
  placement and shared effects shape its role; new oscillators, a modal bell, noise and grains supply the pitched score.
- **Let a pitched recording share onsets with new voices.** A rev or a brake scream that has its own pitch is not retuned: give
  synthetic root, fifth and octave voices the same onsets and releases, so the chord comes from the synthesis and the character
  from the recording.
- **A motor can be the pulse.** Crops of a steady engine, gated on the grid, carry a rhythm; dropping them out for a few bars and
  bringing them back under dry percussion is an arrangement move, as with any part.
- **Use a real transient for a rhythmic part.** A gated bed's onset was inaudible as rhythm; a short crop with an actual transient
  read.

## 3. Mixing and checking

- **Revise from stems.** `beeps song stems` named the parts that were buried and the low layers that masked them; recorded
  mechanisms were brought forward and sub-bass reduced until no part was reported buried. A first motor layer obscured everything
  else until it was rebalanced.
- **Judge a sparse accent by its peak** as well as its integrated level: a few loud hits measure quiet over a whole song.
- **Keep a warning only as a written decision.** A low-end warning on a percussion-only piece with no bass part, a source's real
  low fundamental, a part voiced above its instrument's root: each was kept on purpose and recorded as a listening decision, not
  waived.
- **Bridge sections with finite notes.** A recording that should carry across a section boundary is a note as long as the
  patch, so it is already playing when the next section starts.
- **These are one-shots with tails, not loops.** A study made this way is not a seamless game loop until its seam is checked
  (`beeps loopcheck`).
- **Keep the rejected version.** An earlier candidate left in the project lets the owner compare, and shows what a change removed.

## 4. Toward a game

A baked stereo scene cannot follow the player. In a game, deliver localized cues separately and usually mono and dry, and let the
engine supply position, distance falloff, occlusion and reverberation; keep broad ambience as overlapping zones that fade, attach
fixed emitters to the things that make the sounds, and keep music nonspatial. Decide what happens to distant voices when the
engine runs out of them, and do not restart a soundscape when the player crosses a repeat in the route.
