// Types for the vendored game player (player.js). Hand-written next to the JSDoc; tests/player/player-types.test.ts keeps them honest.

export const PLAYER_VERSION: string;

export type LevelBus = 'music' | 'ambience' | 'sfx' | 'master';

export interface VariantFile { file: string; weight?: number }
export interface LayerFile { name: string; file: string }

/** One entry of index.json (`beeps bundle`). */
export interface Asset {
  file: string;
  loop?: boolean;
  priority?: number;
  cooldownSec?: number;
  cap?: number;
  variants?: VariantFile[];
  noRepeat?: boolean;
  bpm?: number;
  meter?: number;
  durationSec?: number;
  /** Exact length in sample frames; a loop whose decoded buffer is longer ends here, and a different length is reported as W_LOOP_LENGTH. */
  frames?: number;
  layers?: LayerFile[];
  states?: Record<string, string[]>;
  initialState?: string;
  /** dB per state that brings it to the music loudness (written by `beeps song export --layers`); the player applies it to that state's layers. */
  stateTrimDb?: Record<string, number>;
}

export interface PlayerError { code: string; message: string; id?: string }

export interface FetchResponse {
  ok: boolean;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PlayerOptions {
  catalog: string | { assets: Record<string, Asset> };
  baseUrl?: string;
  voices?: number;
  defaults?: { cooldownSec?: number; cap?: number };
  onError?: (e: PlayerError) => void;
  context?: AudioContext;
  contextFactory?: () => AudioContext;
  fetcher?: (url: string) => Promise<FetchResponse>;
  seed?: number;
  /**
   * Keep decoded audio under about this many bytes (a stereo 48 kHz minute is ~23 MB): when a load would go over, the least recently used
   * buffers nothing is playing, scheduled or crossfading are evicted, and load again on demand. Default: no limit, nothing is evicted.
   * Playing audio is never evicted, so the real peak can exceed it (reported once as W_MEMORY_BUDGET).
   */
  memoryBudgetBytes?: number;
  /** 'state': an adaptive song loads only the layers its current state plays and the rest when a state needs them (fade in at the loop's phase). Default 'all'. */
  layerLoading?: 'all' | 'state';
  /** Background loads from `prefetch()` that run at once. Default 2, 1 on phones and tablets. */
  prefetchConcurrency?: number;
}

export interface PlayOptions {
  pan?: number; gainDb?: number; cooldownSec?: number; cap?: number;
  /** 'bar' or 'beat': start on the next bar line (beat) of the music that is playing, a stinger that lands in time. Default 'now'. */
  at?: 'now' | 'beat' | 'bar';
}
export interface PlayHandle { id: string; file: string; ready: Promise<boolean>; stop(fadeSec?: number): void }

export interface BedOptions {
  fadeSec?: number;
  /** Bed level in dB (-60..12), default 0. Asking again for the same bed with a new gainDb ramps it. */
  gainDb?: number;
}
export interface MusicOptions extends BedOptions {
  /** 'bar' or 'beat': start the crossfade on the next bar line (beat) of the music now playing. Default 'now'. */
  at?: 'now' | 'beat' | 'bar';
  /** Start the new loop at the phase the old one has reached (same bpm only), so beats and chords stay in step through the crossfade. */
  sync?: boolean;
}
export interface AmbienceOptions extends BedOptions {
  /** A named independent ambience bed (lowercase-dash, up to 8). Omitted: the main ambience bed. */
  slot?: string;
}

export interface PlayerSnapshot {
  running: boolean;
  voices: number;
  levels: Record<LevelBus, number>;
  /** Temporary attenuation per bus, linear (1 = none); see `duck`. */
  ducks: Record<LevelBus, number>;
  music: { id: string; state: string | null; /** seconds into the loop; absent when the asset has no durationSec */ positionSec?: number; layers: Record<string, number> } | null;
  ambience: { id: string } | null;
  ambienceSlots: Record<string, { id: string }>;
}

/** Decoded-audio memory (`player.memory()`). */
export interface MemoryStats {
  /** The `memoryBudgetBytes` option, or null. */
  budgetBytes: number | null;
  /** Bytes of decoded buffers held now (frames x channels x 4). */
  decodedBytes: number;
  buffers: number;
  /** Loads in flight or queued. */
  loading: number;
  /** Buffers held by something playing or about to play, and their bytes: these are never evicted. */
  pinnedBuffers: number;
  pinnedBytes: number;
  /** Buffers dropped by the budget. */
  evictions: number;
  /** Buffers dropped by `unload()`. */
  unloads: number;
  /** Evicted buffers that were loaded again. */
  reloads: number;
  /** Reloads within 30 s of the eviction (each file also reports W_MEMORY_THRASH once). */
  thrash: number;
  /** Prefetches skipped because they would not fit the budget. */
  skippedPrefetch: number;
  /** The most decoded bytes held at once. */
  peakBytes: number;
}

/** A song id, or an id with the adaptive state likely to come next. */
export type PrefetchItem = string | { id: string; state?: string };

export interface Player {
  unlock(): Promise<boolean>;
  play(id: string, o?: PlayOptions): PlayHandle | null;
  music(id: string | null, o?: MusicOptions): Promise<boolean>;
  ambience(id: string | null, o?: AmbienceOptions): Promise<boolean>;
  setState(state: string, o?: { fadeSec?: number; at?: 'now' | 'beat' | 'bar' }): boolean;
  setLevel(bus: LevelBus, value: number): void;
  /** Turn a bus down by `gainDb` (0 releases) over `fadeSec`, on top of its `setLevel` level. Dialogue and menus duck music and ambience with it. */
  duck(bus: LevelBus | LevelBus[], gainDb: number, o?: { fadeSec?: number }): void;
  setEnabled(enabled: boolean): void;
  setHidden(hidden: boolean): void;
  stopAll(fadeSec?: number): void;
  retry(): void;
  /** Decode these in the background (capped concurrency, never ahead of a load being waited for) so a later play/music starts at once. Resolves how many files are decoded; never rejects. Queued until `unlock()` if called before it. */
  prefetch(ids: PrefetchItem[]): Promise<number>;
  /** Drop an asset's decoded buffers (files, variants, layers) that nothing is playing; they load again on demand. Returns the bytes freed now. */
  unload(id: string): number;
  memory(): MemoryStats;
  inspect(): PlayerSnapshot;
}

export function createPlayer(opts: PlayerOptions): Player;
