import { z } from 'zod';
import { queueNotice } from '../notices.ts';
import { parseTolerant, unknownKeyNotices } from '../strict-parse.ts';

const MODES = ['chromatic', 'major', 'minor', 'dorian', 'majorPentatonic', 'minorPentatonic', 'blues'] as const;

export const ProjectSchema = z.strictObject({
  schema: z.literal('beeps/project@1'),
  scale: z.strictObject({
    root: z.string().regex(/^[A-G](#|b)?$/).default('C'),
    mode: z.enum(MODES).default('majorPentatonic'),
    snap: z.boolean().default(true),
  }).prefault({}),
  /** Max momentary loudness (LUFS) that one-shots are trimmed to. */
  targetLoudness: z.number().min(-40).max(-6).default(-18),
  /** Loudness offsets (LU re targetLoudness) by patch family, over the stock table: footsteps and foley sit under strikes. A family not listed keeps its stock offset (0 for families the stock table does not know). */
  familyOffsets: z.record(z.string(), z.number().min(-30).max(12)).optional(),
  /** Integrated loudness (LUFS) songs are trimmed to: under the one-shots, so SFX read over music. */
  musicLoudness: z.number().min(-40).max(-6).default(-20),
  sampleRate: z.literal(48000).default(48000),
});

export type Project = z.output<typeof ProjectSchema>;
export type Scale = Project['scale'];
/**
 * Parses a project file. A key the schema does not know is stripped and queued as N_UNKNOWN_KEY (see strict-parse.ts), so a typo is
 * reported instead of silently leaving the default; anything else wrong throws as before.
 */
export function parseProject(input: unknown): Project {
  const r = parseTolerant(ProjectSchema, input);
  if (!r.ok) throw r.error;
  for (const n of unknownKeyNotices(r.unknown, 'project.json')) queueNotice(n);
  return r.data;
}
export const defaultProject = (): Project => parseProject({ schema: 'beeps/project@1' });
