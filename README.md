# agent-beeps-runtime

Generated from [agent-beeps](https://github.com/ehartye/agent-beeps) by `scripts/build-runtime-package.mjs`. Do not edit.

The browser-safe runtime: files byte-identical to their sources, no engine dependencies (`zod` only
for the schema entry). The engine entry is plain JavaScript with `.d.ts` types; the schema entry is
TypeScript source, so import it with a bundler or runner that accepts `.ts`. Import `parsePatch` from
`agent-beeps-runtime/schema` only for raw patch JSON; generated cues already contain parsed patches.

The engine entry exports `loadCueAssets` for recorded-source/hybrid cues. `build` stays synchronous
and performs no I/O. A voice starts once: resume the context within each user gesture, asynchronously
load verified assets, then build a fresh voice. Cache immutable buffers, not already-started voices.
This example assumes `#play`, `#stop` buttons and a `#status` text element; load the cue before enabling
Play, and use its actual URL including any static project subpath.

```js
import { build, parseCue, loadCueAssets } from 'agent-beeps-runtime';

const ctx = new AudioContext();
const out = ctx.destination; // or your master gain
const playButton = document.querySelector('#play');
const stopButton = document.querySelector('#stop');
const status = document.querySelector('#status');
let cueURL = new URL('/audio/contact-hybrid.runtime.json', location.href);
let cue = parseCue(await (await fetch(cueURL)).json());
let generation = 0, pending, voice, cached;

function stop() {
  generation++;
  pending?.abort();
  pending = undefined;
  voice?.dispose();
  voice = undefined;
  status.textContent = 'Stopped';
}

playButton.onclick = async () => {
  stop();
  const mine = generation;
  const controller = pending = new AbortController();
  const selectedCue = cue, baseURL = cueURL;
  status.textContent = 'Loading';
  try {
    await ctx.resume(); // called within this user gesture, before awaiting asset I/O
    if (mine !== generation || controller.signal.aborted) return;
    const samples = cached ?? await loadCueAssets(ctx, selectedCue, {
      baseURL, signal: controller.signal,
    });
    if (mine !== generation || controller.signal.aborted) return;
    cached = samples; // verified immutable buffers, for this cue and context only
    voice = build(ctx, out, selectedCue, { samples, onEnded() {
      if (mine === generation) { voice = undefined; status.textContent = 'Stopped'; }
    } }).start(); // build a fresh voice on EVERY play; a voice starts only once
    status.textContent = 'Playing';
  } catch (error) {
    if (mine === generation && !controller.signal.aborted) {
      status.textContent = `Playback failed: ${error.message}`;
    }
  } finally {
    if (pending === controller) pending = undefined;
  }
};
stopButton.onclick = stop;

// When selecting another already-fetched cue, cancel the previous play/loading first.
function selectCue(nextCueJson, nextURL) {
  stop();
  cue = parseCue(nextCueJson);
  cueURL = new URL(nextURL, location.href);
  cached = undefined;
}
```

`loadCueAssets` verifies the exact prepared dependency closure, bounded bytes, content hashes and
canonical WAV metadata; it works on HTTP LAN origins without WebCrypto and has no automatic cache.
Stop/replacement aborts pending work and generation checks reject late resume/load completions.
Procedural cues need no sample files; the loader returns an empty map for them. Add `params` for
named starting inputs and `reverb` for an optional shared `createReverbBus`.

Engine 4 is required for these cues. A patch has up to eight layers. Prepared samples are finite,
unpitched one-shots of 1–480000 frames at 48 kHz, mono/stereo (up to ten seconds); no sample pitch
envelopes/pitch LFOs, loops, stretching or song sample instruments. Gain/cutoff LFOs remain supported.
Import/preparation happens in the authoring CLI, not this runtime package. The game ships only the
prepared sources its cue needs. Attenuation cannot restore an already clipped source recording.

See [docs/runtime.md](https://github.com/ehartye/agent-beeps/blob/main/docs/runtime.md) for the API,
inputs, shared reverb bus, source limits and measurements; see the hybrid source reference for
portable authoring bundles and their preparation/privacy boundary.
