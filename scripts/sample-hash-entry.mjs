import { sha256 } from '@noble/hashes/sha2.js';

/** SHA256 of the exact supplied byte range, as lowercase hexadecimal. */
export const sampleHash = bytes => Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');
