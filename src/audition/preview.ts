import { createHash, randomBytes } from 'node:crypto';
import { BeepsError } from '../errors.ts';

export type PreviewKind = 'session' | 'album' | 'delivery';
export type PreviewGrant = { id: string; kind: PreviewKind; target: string; root: string; feedback: boolean; expiresAt: number };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export const previewEvents = {
  session: new Set(['play', 'lineup', 'duel']),
  album: new Set(['play', 'mark', 'tags', 'note', 'moment']),
  delivery: new Set(['device', 'rate', 'note']),
};

/** Ephemeral capabilities: never persisted, never a server-management credential. */
export class PreviewGrants {
  private grants = new Map<string, PreviewGrant>();
  private now: () => number;
  constructor(now = () => Date.now()) { this.now = now; }
  issue(input: Omit<PreviewGrant, 'id' | 'expiresAt'>, seconds = 3600) {
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400)
      throw new BeepsError('E_USAGE', 'preview lifetime must be 60–86400 seconds');
    for (const [key, value] of this.grants) if (value.expiresAt <= this.now()) this.grants.delete(key);
    if (this.grants.size >= 256) throw new BeepsError('E_SERVER', 'preview limit reached; revoke unused links');
    const token = randomBytes(32).toString('hex');
    const grant = { ...input, id: randomBytes(16).toString('hex'), expiresAt: this.now() + seconds * 1000 };
    this.grants.set(hash(token), grant);
    return { token, grant };
  }
  get(token: string) {
    const key = hash(token), grant = this.grants.get(key);
    if (grant && grant.expiresAt > this.now()) return grant;
    this.grants.delete(key);
    return undefined;
  }
  active(grant: PreviewGrant) { return grant.expiresAt > this.now() && [...this.grants.values()].includes(grant); }
  revoke(id: string) {
    for (const [key, grant] of this.grants) if (grant.id === id) return this.grants.delete(key);
    return false;
  }
  clear() { this.grants.clear(); }
}
