// Unit conversions shared across the engine. Browser-safe: no Node APIs.

/**
 * Decibels to a linear gain (amplitude ratio).
 * @param {number} db
 */
export const dbToGain = db => 10 ** (db / 20);
