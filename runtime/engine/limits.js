// The prepared-sample limits the engine, the WAV codec, the transport and the CLI all enforce. Browser-safe: no Node APIs.

/** The only sample rate a prepared sample (and the offline render) may have, Hz. */
export const SAMPLE_RATE_HZ = 48000;

/** Most frames a prepared sample may hold: ten seconds at 48 kHz. */
export const MAX_SAMPLE_FRAMES = SAMPLE_RATE_HZ * 10;

/** Most frames a retained source snapshot may hold: two minutes at 48 kHz. */
export const MAX_SOURCE_FRAMES = SAMPLE_RATE_HZ * 120;

/** Largest prepared sample WAV, bytes: the 44-byte header plus `MAX_SAMPLE_FRAMES` stereo float32 frames. */
export const MAX_SAMPLE_WAV_BYTES = 44 + MAX_SAMPLE_FRAMES * 2 * 4;
