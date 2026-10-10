// The runtime entry: what a game imports to play beeps patches in its own AudioContext. Browser-safe, no dependencies.
// Everything here is also what `beeps build` measures and bakes, so a sound is the same sound on either delivery path.
// The package `agent-beeps-runtime` is generated from this file's import closure (scripts/build-runtime-package.mjs).
export { build, parseCue, CUE_SCHEMA } from './voice.js';
export { createReverbBus } from './fx.js';
export { createPicker } from './variation.js';
export { patchLength } from './patch.js';
export { defaultParams, clampInput, MACROS } from './params.js';
export { setNoiseCacheLimit, noiseCacheStats, NOISE_CACHE_BYTES } from './sources.js';
export { REVERB_PRESETS } from './fx.js';
export { ENGINE_VERSION } from './version.js';
