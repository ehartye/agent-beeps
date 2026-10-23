import { z } from 'zod';

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
/** Parses a project file. A key the schema does not know is an error, not a default left in place: a misspelled "scale" must not pass. */
export const parseProject = (input: unknown): Project => ProjectSchema.parse(input);
export const defaultProject = (): Project => parseProject({ schema: 'beeps/project@1' });
