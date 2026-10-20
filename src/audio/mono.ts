/**
 * Mono mixdown: the channel itself when there is one, otherwise the mean of all channels.
 * The sum is taken in double precision and rounded once, so two channels give exactly
 * `(L + R) / 2` as a float32 and the result does not depend on the channel order.
 */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    out[i] = sum / channels.length;
  }
  return out;
}
