// Types of the runtime entry (index.js). The patch type is the schema's own (src/schema/patch.ts), so a patch parsed with
// parsePatch from the schema entry is exactly what `build` takes.
import type { Patch } from '../../src/schema/patch.ts';

export type { Patch };

/** The engine version a cue was measured with. Bump means the sound of a patch changed. */
export const ENGINE_VERSION: string;
export const CUE_SCHEMA: 'beeps/runtime-cue@1';

export type ScaleMode = 'chromatic' | 'major' | 'minor' | 'dorian' | 'majorPentatonic' | 'minorPentatonic' | 'blues';
/** Pitched sources snap to this scale when `snap` is true; variant and runtime offsets apply after the snap. */
export interface Scale { root: string; mode: ScaleMode; snap: boolean }

export type ReverbPreset = 'small' | 'room' | 'hall' | 'cave' | 'space';
export const REVERB_PRESETS: Readonly<Record<ReverbPreset, { decay: number; lpStart: number; lpEnd: number; preDelay: number }>>;

/** A runtime cue: what `beeps build` writes (`<id>.runtime.json`) for a patch whose delivery is `runtime` or `both`. */
export interface Cue {
  schema: 'beeps/runtime-cue@1';
  id: string;
  /** Engine version the loudness trim was measured with. */
  engine: string;
  /** The seed the baked asset uses; the voice's default. */
  seed: number;
  /** Loudness trim in dB that matches the baked asset's level at the input defaults. */
  trimDb: number;
  /** The project scale the trim and the baked asset were made with; the voice's default. */
  scale?: Scale;
  patch: Patch;
}

/** Validate a parsed cue file. Throws for another schema, a malformed cue, or (unless allowed) another engine version. */
export function parseCue(value: unknown, opts?: { allowEngineMismatch?: boolean }): Cue;

/** A reverb the game owns and voices send to, instead of a convolver per voice. */
export interface ReverbBus {
  /** Voices send here (the bus's convolver). */
  readonly input: AudioNode;
  /** The wet return, connected to the destination the bus was made with. */
  readonly output: GainNode;
  readonly preset: ReverbPreset;
  /** Disconnect the bus. Voices still sending to it go silent on the wet side. */
  dispose(): void;
}
/** One bus (every voice sends to it) or buses by preset (a voice whose preset is missing builds its own reverb). */
export type ReverbBuses = ReverbBus | Partial<Record<ReverbPreset, ReverbBus>>;

/** Make a shared reverb bus: one convolver for the mix. `out` receives the wet return. */
export function createReverbBus(ctx: BaseAudioContext, out: AudioNode, opts?: { preset?: ReverbPreset; returnDb?: number }): ReverbBus;

export interface BuildOptions {
  /** Selects the noise and grain content and the variant's draw. Default: the cue's seed, else 1. */
  seed?: number;
  /** Starting input values by name. Absent inputs sit at their declared defaults; unknown names throw. */
  params?: Record<string, number>;
  /** Which declared variant to voice (0 is the patch as written). */
  variant?: number;
  /** Loudness trim in dB. Default: the cue's measured trim, else 0. */
  trimDb?: number;
  /** Pitched sources snap to it when its `snap` is true. Default: the cue's project scale. `null`: none (continuous pitch). */
  scale?: Scale | null;
  /** The transparent safety clipper on the voice's output (default true; a game with its own master limiter may drop it). */
  limiter?: boolean;
  /** Sound until stopped instead of ending at the patch's duration. Default: the patch's `xRuntime.hold`. */
  hold?: boolean;
  /** Also receive the signal before the trim and limiter. */
  tap?: AudioNode;
  /** Send the patch's reverb to a shared bus instead of building a convolver in the voice. */
  reverb?: ReverbBuses;
  /** Called once when the voice is finished: it ended on its own, was stopped, or was disposed. */
  onEnded?: () => void;
}

export interface Voice {
  /** True once `start` has created the graph. */
  readonly started: boolean;
  /** Context time the voice is silent, effect tails included (a shared reverb bus's tail is not the voice's). Infinity while a held voice is held; undefined before `start`. */
  readonly end: number | undefined;
  /** Create the graph and begin at `at` (default: now). A voice plays once. */
  start(at?: number): Voice;
  /**
   * Move an input. Before `start`, any declared input. After it, only inputs whose bindings are all `live`:
   * they automate a parameter the graph already has (no node is created) with time constant `tau` seconds (default 0.02).
   * A value outside the input's declared range is clamped. Throws for an unknown input, or a static one after `start`.
   */
  set(input: string, value: number, at?: number, tau?: number): void;
  /**
   * End the voice. A held voice releases at `at` with the patch's own release; any other fades out over `fade` seconds
   * (default 0.02). Returns the context time it is silent. Nothing happens to a voice that already ended.
   */
  stop(at?: number, fade?: number): number;
  /** Stop every source now and cut the voice from its output and sends, so the graph can be collected. Not a fade: use `stop` for audible endings. */
  dispose(): void;
}

/**
 * Plan a voice of a patch (parsed, defaults filled) or a cue. Nothing is created in the audio graph until `start`.
 * Throws for an unparsed patch, an unknown input name, or a non-finite input value.
 */
export function build(ctx: BaseAudioContext, out: AudioNode, source: Patch | Cue, opts?: BuildOptions): Voice;

/** Seconds from onset until the patch is silent, effect tails included (to size an offline context). */
export function patchLength(patch: Patch): number;

/** The declared default of every input of the patch. */
export function defaultParams(patch: Patch): Record<string, number>;
/** Clamp a value to an input's declared range. */
export function clampInput(input: { min: number; max: number }, value: number): number;
/** The macro targets of `xRuntime` bindings and their units. */
export const MACROS: Readonly<{ '/out/gainDb': 'db'; '/out/transpose': 'st'; '/out/brightness': 'oct' }>;

/** Picks variants for successive plays: honours permutation weights and never repeats the previous one when `noRepeat` is set. */
export function createPicker(patch: { variation?: { variants?: number; weights?: number[]; noRepeat?: boolean } }, seed: number): { next(): number };

/** Byte budget of the per-context noise-buffer cache (default 16 MiB). Least recently used buffers are evicted past it. */
export const NOISE_CACHE_BYTES: number;
/** Change the budget of every context's noise cache. `Infinity` restores the unbounded behaviour of engine versions before the bound. */
export function setNoiseCacheLimit(bytes: number): void;
export function noiseCacheStats(ctx: BaseAudioContext): { entries: number; bytes: number; limit: number };
