// Plain-words taste profile the agent reads before composing.
import { FEATURE_NAMES, type FeatureName } from '../measure/index.ts';
import { standardErrors, type Model } from './model.ts';

const WORDS: Record<FeatureName, [string, string]> = {
  energyLength: ['longer', 'shorter'],
  attack: ['softer attacks', 'punchier attacks'],
  brightness: ['brighter', 'darker'],
  sharpness: ['sharper', 'less sharp'],
  roughness: ['grittier', 'smoother'],
  fluctuation: ['more wobble', 'steadier'],
  noisiness: ['noisier', 'more tonal'],
  pitchStrength: ['clearly pitched', 'less pitched'],
  pitchDirection: ['rising', 'falling'],
  punch: ['more transient', 'denser'],
  register: ['higher', 'lower'],
};

export interface Preference { feature: FeatureName; weight: number; se: number; words: string; confidence: 'strong' | 'weak' | 'unknown' }

export function summarize(m: Model, verdicts: number): { preferences: Preference[]; markdown: string } {
  const se = standardErrors(m);
  const prefs = FEATURE_NAMES.map((feature, i) => {
    const z = se[i] > 0 ? Math.abs(m.w[i]) / se[i] : 0;
    return {
      feature, weight: Math.round(m.w[i] * 1000) / 1000, se: Math.round(se[i] * 1000) / 1000,
      words: m.w[i] >= 0 ? WORDS[feature][0] : WORDS[feature][1],
      confidence: (z > 2 ? 'strong' : z > 1 ? 'weak' : 'unknown') as Preference['confidence'],
      z,
    };
  }).sort((a, b) => b.z - a.z).map(({ z: _z, ...p }) => p);

  const known = prefs.filter(p => p.confidence !== 'unknown');
  const lines = [
    '# Taste profile',
    '',
    `Learned from ${verdicts} explicit judgements${m.projectLayer ? ' (global taste plus this project\'s layer)' : ''}.`,
    '',
    known.length ? 'Prefers, in order of confidence:' : 'Not enough judgements yet to state a preference with confidence.',
    ...known.slice(0, 5).map(p => `- **${p.words}** (${p.feature}, ${p.confidence}, weight ${p.weight} ± ${p.se})`),
    '',
    `Unknown so far: ${prefs.filter(p => p.confidence === 'unknown').map(p => p.feature).join(', ') || 'none'}.`,
    '',
    'Weights are per typical spread of each feature across game sounds, relative to the other candidates in each',
    'audition. They are indicators of',
    'what the owner has chosen, not rules: the owner\'s ear is the judge.',
  ];
  return { preferences: prefs, markdown: lines.join('\n') + '\n' };
}
