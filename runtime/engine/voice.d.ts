// EXPERIMENTAL (runtime-codegen spike). The shape of a runtime voice: what `createVoice` (interpreter) and every generated
// cue module's `build` return, so a game can use either per cue.
export interface Voice {
  /** Context time the voice is silent, effect tails included. Infinity while a `hold` voice is held. */
  end: number;
  /** Move a live input. Automates a parameter the graph already has: no node is created, nothing is scheduled twice. */
  set(input: string, value: number, at?: number, tau?: number): void;
  /** End a `hold` voice at `at` (default now); returns when it is silent. A voice that is not held ignores it and ends by itself. */
  release(at?: number): number;
  /** Fade out and disconnect now. */
  stop(fade?: number): void;
}
export interface BuildOptions {
  /** Context time to start at. */
  when?: number;
  /** Which of the patch's declared variants to voice (0 is the patch as written). */
  variant?: number;
  /** The game's own scale: pitched sources snap to it when `snap` is true. */
  scale?: { root: string; mode: string; snap: boolean };
  /** Loudness trim in dB. Default: the trim measured when the module was emitted. */
  trimDb?: number;
  /** The transparent safety clipper on the voice's output (default true; a game with its own master limiter may drop it). */
  limiter?: boolean;
}
