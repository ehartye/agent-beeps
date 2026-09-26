// Perceptual directions shared by refine requests, mutate, and prompt steering in generate.
import { FEATURE_NAMES, type FeatureName } from './measure/index.ts';
import { FEATURE_SCALES } from './audition/session.ts';

export const DIRECTIONS: Record<string, Partial<Record<FeatureName, number>>> = {
  brighter: { brightness: 1, sharpness: 0.5 },
  darker: { brightness: -1, sharpness: -0.5 },
  punchier: { attack: -1, punch: 1 },
  softer: { attack: 1, punch: -1 },
  shorter: { energyLength: -1 },
  longer: { energyLength: 1 },
  'less-harsh': { sharpness: -1, roughness: -1 },
  'more-character': { roughness: 0.5, fluctuation: 0.5, pitchDirection: 0.3 },
};

/** How far `child` moved from `parent` along the requested directions, in taste-feature scale units. */
export function directionScore(parent: number[], child: number[], directions: string[]): number {
  let s = 0;
  for (const d of directions) for (const [name, w] of Object.entries(DIRECTIONS[d] ?? {})) {
    const i = FEATURE_NAMES.indexOf(name as FeatureName);
    s += (w ?? 0) * (child[i] - parent[i]) / FEATURE_SCALES[i];
  }
  return s;
}

/** Everyday words in a request mapped to directions ("cozy, soft coin" → darker, softer, less-harsh). */
const WORDS: [RegExp, string[]][] = [
  [/\b(soft|gentle|mellow|cozy|cosy|warm|calm|subtle|round(ed)?)\b/i, ['softer', 'less-harsh']],
  [/\b(dark|deep|muffled|low|warm|cozy|cosy|mellow)\b/i, ['darker']],
  [/\b(bright|sparkl\w*|shiny|crisp|airy|glitter\w*)\b/i, ['brighter']],
  [/\b(short|snappy|quick|tight|tiny|brief)\b/i, ['shorter']],
  [/\b(long|lingering|ringing|sustained|big|epic)\b/i, ['longer']],
  [/\b(punchy|punch|hard|impact\w*|sharp attack|snappy)\b/i, ['punchier']],
  [/\b(harsh|gritty|crunchy|dirty|weird|quirky|character)\b/i, ['more-character']],
  [/\b(not harsh|smooth|clean|pleasant)\b/i, ['less-harsh']],
];

export function promptDirections(prompt: string | undefined | null): string[] {
  if (!prompt) return [];
  const out = new Set<string>();
  for (const [re, dirs] of WORDS) if (re.test(prompt)) dirs.forEach(d => out.add(d));
  // "not harsh" must not also read as a request for character
  if (/\bnot (harsh|gritty|crunchy)\b/i.test(prompt)) out.delete('more-character');
  if (out.has('brighter') && out.has('darker')) { out.delete('brighter'); out.delete('darker'); }
  if (out.has('shorter') && out.has('longer')) { out.delete('shorter'); out.delete('longer'); }
  return [...out];
}
