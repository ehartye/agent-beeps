# M16 rifle · sustained burst

Source: **M16 automatic rifle shots**, original WAV from the [SSE Library: GUNS](https://archive.org/details/SSE_Library_GUNS/AUTOMATIC/GUNAuto_M16%20automatic%20rifle%20shots_CS_USC.wav).
The archive credits USC Cinema and/or the Sunset Editorial Collection and declares CC0.
The file is not a preview transcode. Its original archive member name is preserved in provenance.

One sustained M16 rifle burst, followed by its natural room tail. The recording is not repeated. Compare it with the pulsing body and hybrid at the same measured listening level.

The 5.5063-second preparation crops original frames 0–264304,
with a 5 ms fade in, 40 ms fade out and unity gain. Mono is preserved.
The complete original sequence and its natural room tail are retained.

Each procedural group is a low noise bed with a fading ADSR envelope and 20 Hz tremolo.
This designed weight does not reconstruct individual shots. The recording preserves its cadence
and room. Takes are independently matched in measured max-momentary loudness; solos are comparisons,
not stems. Generic foley tail-ceiling warnings are retained because these are intentional long
recorded sequences rather than single short impacts.

The strict preparation-bundle contains canonical source, prepared audio, three patches and exact
preparation receipt, with no original file, private path or import receipt. In an initialized project:

```sh
beeps sample sync /path/to/fuse-m16/preparation-bundle
beeps render fuse-m16-recording fuse-m16-procedural fuse-m16-hybrid
```

From this repository, node scripts/compose-fuse-heavy.mjs replays every gun bundle without originals.
The ordinary showcase render/build path publishes the listening studies. Existing metal packs
demonstrate the downloadable preparation workflow; no separate gun download archive is needed.
