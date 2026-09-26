// The verdict log: append-only JSONL, one explicit judgement per line. It is the source of truth;
// every model is refit from it. Replays and dwell time are never verdicts (audition shapes preference).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const Side = z.object({ name: z.string(), family: z.string(), x: z.array(z.number()) });

export const VerdictSchema = z.object({
  schema: z.literal('beeps/verdict@1'),
  at: z.string(),
  project: z.string(),
  session: z.string(),
  /** duel: head-to-head; implied: from lineup ♥/✗; bothBad: loser against the family-mean reference; tie: logged, not fitted */
  kind: z.enum(['duel', 'implied', 'bothBad', 'tie']),
  winner: Side.optional(),
  loser: Side.optional(),
  a: Side.optional(),
  b: Side.optional(),
  weight: z.number().positive(),
  tags: z.array(z.string()).default([]),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const beepsHome = () => resolve(process.env.AGENT_BEEPS_HOME || join(homedir(), '.agent-beeps'));
export const globalTasteDir = () => join(beepsHome(), 'taste');
export const globalVerdictsFile = () => join(globalTasteDir(), 'verdicts.jsonl');

export function appendVerdicts(files: string[], rows: Verdict[]): void {
  if (!rows.length) return;
  const text = rows.map(r => JSON.stringify(VerdictSchema.parse(r))).join('\n') + '\n';
  for (const f of files) {
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, text);
  }
}

export function readVerdicts(file: string): { rows: Verdict[]; malformed: number } {
  if (!existsSync(file)) return { rows: [], malformed: 0 };
  const rows: Verdict[] = [];
  let malformed = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = VerdictSchema.safeParse(JSON.parse(line));
      if (r.success) rows.push(r.data); else malformed++;
    } catch { malformed++; }
  }
  return { rows, malformed };
}
