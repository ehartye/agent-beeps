import { z } from 'zod';

const MODES = ['chromatic', 'major', 'minor', 'dorian', 'majorPentatonic', 'minorPentatonic', 'blues'] as const;

export const ProjectSchema = z.object({
  schema: z.literal('beeps/project@1'),
  scale: z.object({
    root: z.string().regex(/^[A-G](#|b)?$/).default('C'),
    mode: z.enum(MODES).default('majorPentatonic'),
    snap: z.boolean().default(true),
  }).prefault({}),
  /** Max momentary loudness (LUFS) that one-shots are trimmed to. */
  targetLoudness: z.number().min(-40).max(-6).default(-18),
  /** Integrated loudness (LUFS) songs are trimmed to: under the one-shots, so SFX read over music. */
  musicLoudness: z.number().min(-40).max(-6).default(-20),
  sampleRate: z.literal(48000).default(48000),
});

export type Project = z.output<typeof ProjectSchema>;
export type Scale = Project['scale'];
export const parseProject = (input: unknown): Project => ProjectSchema.parse(input);
export const defaultProject = (): Project => parseProject({ schema: 'beeps/project@1' });
