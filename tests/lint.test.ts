import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectTailNotes, kitRuleNotes, lintKit, lintPatch, loadRules, variantSiblings, type KitMember } from '../src/lint.ts';
import type { Features } from '../src/measure/index.ts';
import { defaultProject } from '../src/schema/project.ts';
import { targetFor } from '../src/render/pipeline.ts';
import type { Patch } from '../src/schema/patch.ts';
import { coin, patch } from './helpers/patches.ts';

const project = defaultProject();

/** A clean, on-target feature set for `p`; override fields to provoke one rule at a time. */
function features(p: Patch, over: Partial<Features> = {}, delivered: Partial<Features['delivered']> = {}): Features {
  const base: Features = {
    durationSec: 0.3, samplePeakDb: -6, truePeakDb: -5.8, dcOffset: 0, clippedSamples: 0,
    momentaryMaxLufs: -20, shortTermMaxLufs: -22, integratedLufs: -20, integratedReliable: false,
    attackSec: 0.004, energyLengthSec: 0.05, tailSec: 0.12, crestDb: 12,
    centroidHz: 2000, centroidPeakHz: 2200, flatness: 0.1, bands: [-40, -35, -30, -20, -10, -3, -12, -30],
    sharpness: 1.5, roughness: 0.1, fluctuation: 0.05,
    pitchHz: 0, pitchStrength: 0, pitchDirection: 0, voicedFraction: 0,
    delivered: { samplePeakDb: -2, truePeakDb: -1.5, momentaryMaxLufs: targetFor(p, project), clippedSamples: 0 },
  };
  return { ...base, ...over, delivered: { ...base.delivered, ...delivered } };
}

const rulesOf = (fs: { rule: string }[]) => fs.map(f => f.rule);

describe('lintPatch', () => {
  it('passes a clean coin', () => {
    const p = coin();
    const r = lintPatch(p, features(p), project);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('flags a 1 ms attack on a non-click patch with a pointer', () => {
    const p = coin();
    p.layers[0].amp.attack = 0.001;
    const r = lintPatch(p, features(p), project);
    expect(r.errors).toContainEqual(expect.objectContaining({ rule: 'attack-floor', pointer: '/layers/0/amp/attack' }));
  });

  it('flags a measured attack under 2 ms', () => {
    const p = coin();
    const r = lintPatch(p, features(p, { attackSec: 0.001 }), project);
    expect(rulesOf(r.errors)).toContain('attack-floor');
  });

  it('lets click intent through the attack floor', () => {
    const p = coin();
    p.layers[0].amp.attack = 0.001;
    p.meta = { priority: 3, intent: 'click' };
    const r = lintPatch(p, features(p, { attackSec: 0.0005 }), project);
    expect(rulesOf(r.errors)).not.toContain('attack-floor');
  });

  it('flags an additive partial at 30 kHz with its pointer', () => {
    const p = patch({
      schema: 'beeps/patch@1', name: 'bell', family: 'confirm', duration: 1,
      layers: [{ source: { type: 'additive', pitch: 1000, partials: [[1, 0, 0.5], [2.76, -6, 0.3], [30, -20, 0.1]] }, amp: { attack: 0.005, decay: 0.8 } }],
    });
    const r = lintPatch(p, features(p), project);
    const ny = r.errors.filter(f => f.rule === 'nyquist');
    expect(ny).toHaveLength(1);
    expect(ny[0].pointer).toBe('/layers/0/source/partials/2');
  });

  it('checks pitchEnv targets against partial ratios', () => {
    const p = patch({
      schema: 'beeps/patch@1', name: 'sweep', family: 'powerup', duration: 1,
      layers: [{ source: { type: 'osc', wave: 'sine', pitch: 1000 }, pitchEnv: [{ at: 0.5, to: 23000 }], amp: { attack: 0.005, decay: 0.8 } }],
    });
    const r = lintPatch(p, features(p), project);
    expect(r.errors).toContainEqual(expect.objectContaining({ rule: 'nyquist', pointer: '/layers/0/pitchEnv/0/to' }));
  });

  it('ignores filter cutoffs above the Nyquist guard', () => {
    const p = coin();
    p.layers[0].filter = { type: 'lowpass', cutoff: 23000, resonanceDb: 0 };
    expect(rulesOf(lintPatch(p, features(p), project).errors)).not.toContain('nyquist');
  });

  it('flags a long ui-click as tick-length', () => {
    const p = patch({ schema: 'beeps/patch@1', name: 'tap', family: 'ui-click', duration: 0.3,
      layers: [{ source: { type: 'osc', wave: 'triangle', pitch: 'C6' }, amp: { attack: 0.004, decay: 0.2 } }] });
    const r = lintPatch(p, features(p, { energyLengthSec: 0.18, tailSec: 0.2 }), project);
    expect(rulesOf(r.errors)).toContain('tick-length');
  });

  it('warns when the tail exceeds the family ceiling', () => {
    const p = coin();
    const r = lintPatch(p, features(p, { tailSec: 1.1 }), project);
    expect(rulesOf(r.warnings)).toContain('tail-ceiling');
  });

  it('flags loudness 3 LU off target', () => {
    const p = coin();
    const r = lintPatch(p, features(p, {}, { momentaryMaxLufs: targetFor(p, project) + 3 }), project);
    expect(rulesOf(r.errors)).toContain('loudness-target');
    const ok = lintPatch(p, features(p, {}, { momentaryMaxLufs: targetFor(p, project) - 1 }), project);
    expect(rulesOf(ok.errors)).not.toContain('loudness-target');
  });

  it('flags true peak, clipping and DC', () => {
    const p = coin();
    const r = lintPatch(p, features(p, { dcOffset: 0.01 }, { truePeakDb: -0.2, clippedSamples: 4 }), project);
    expect(rulesOf(r.errors)).toEqual(expect.arrayContaining(['true-peak-ceiling', 'no-clipping', 'no-dc']));
  });

  it('warns on sharpness and roughness unless tagged', () => {
    const p = coin();
    const f = features(p, { sharpness: 3, roughness: 0.9 });
    expect(rulesOf(lintPatch(p, f, project).warnings)).toEqual(expect.arrayContaining(['sharpness-warn', 'roughness-warn']));
    p.tags = ['bright', 'gritty'];
    expect(lintPatch(p, f, project).warnings).toEqual([]);
  });

  it('requires variation on a repeating patch', () => {
    const p = coin();
    p.tags = ['repeating'];
    expect(lintPatch(p, features(p), project).errors).toContainEqual(expect.objectContaining({ rule: 'variation-on-repeating', pointer: '/variation' }));
    p.variation = { pitchCents: 30, gainDb: 1, variants: 1, noRepeat: true };
    expect(rulesOf(lintPatch(p, features(p), project).errors)).not.toContain('variation-on-repeating');
  });

  it('accepts sibling patches as the variants of a repeating patch', () => {
    const p = coin();
    p.tags = ['repeating'];
    const ok = lintPatch(p, features(p), project, undefined, { siblings: ['coin-1', 'coin-2'] });
    expect(rulesOf(ok.errors)).not.toContain('variation-on-repeating');
    const short = lintPatch(p, features(p), project, undefined, { siblings: ['coin-1'] });
    expect(short.errors).toContainEqual(expect.objectContaining({ rule: 'variation-on-repeating', message: expect.stringMatching(/1 sibling patch.*variantOf/) }));
  });

  it('names the fixes that work for DC, and the layers likely to carry it', () => {
    const boom = patch({
      schema: 'beeps/patch@1', name: 'boom', family: 'explosion', duration: 0.45,
      layers: [
        { source: { type: 'osc', wave: 'sine', pitch: 'G2' }, pitchEnv: [{ at: 0.22, to: 'G1' }], amp: { attack: 0.004, decay: 0.22 } },
        { source: { type: 'noise', color: 'brown' }, amp: { attack: 0.004, decay: 0.3 }, filter: { type: 'lowpass', cutoff: 900, resonanceDb: 0 } },
        { source: { type: 'noise', color: 'white' }, amp: { attack: 0.004, decay: 0.05 }, filter: { type: 'highpass', cutoff: 1500, resonanceDb: 0 } },
        { source: { type: 'osc', wave: 'sine', pitch: 'C2' }, amp: { attack: 0.004, decay: 0.2 }, filter: { type: 'highpass', cutoff: 45, resonanceDb: 0 } },
      ],
    });
    const f = lintPatch(boom, features(boom, { dcOffset: 0.004 }), project).errors.find(e => e.rule === 'no-dc');
    expect(f?.message).toMatch(/highpass at 45-50 Hz/);
    expect(f?.message).toMatch(/bandpass instead of lowpass/);
    expect(f?.message).toMatch(/gainDb -4 to -5/);
    expect(f?.message).toMatch(/fx\.dcBlock/);
    expect(f?.message).toMatch(/likely layers: 0, 1\b/);
    expect(f?.pointer).toBe('/layers/0');
    const blocked = patch({ ...boom, fx: { dcBlock: true } });
    expect(lintPatch(blocked, features(blocked, { dcOffset: 0.004 }), project).errors.find(e => e.rule === 'no-dc')?.message).not.toMatch(/fx\.dcBlock: true/);
  });

  it('names the layer highpass for a short low burst, and clears layers that have one', () => {
    const burst = patch({
      schema: 'beeps/patch@1', name: 'thud', family: 'foley', duration: 0.1,
      layers: [
        { source: { type: 'osc', wave: 'sine', pitch: 70 }, amp: { attack: 0.004, decay: 0.09 } },
        { source: { type: 'noise', color: 'white' }, amp: { attack: 0.004, decay: 0.09 }, filter: { type: 'lowpass', cutoff: 300, resonanceDb: 0 } },
      ],
    });
    const msg = (p: typeof burst) => lintPatch(p, features(p, { dcOffset: 0.004 }), project).errors.find(e => e.rule === 'no-dc')!.message;
    expect(msg(burst)).toMatch(/likely layers: 0, 1\)/);
    expect(msg(burst)).toMatch(/set \/layers\/0\/highpass to 42 /);
    expect(msg(burst)).toMatch(/set \/layers\/1\/highpass to 40 /);
    const fixed = patch({ ...burst, layers: burst.layers.map(l => ({ ...l, highpass: 40 })) });
    expect(msg(fixed)).not.toMatch(/likely layers/);
  });

  it('always lists the patch judgement rules', () => {
    const p = coin();
    const judgement = loadRules().filter(r => r.check === 'judgement' && r.appliesTo === 'patch').map(r => r.id);
    expect(judgement).toEqual(expect.arrayContaining(['silent-not-quiet', 'synthesis-choice']));
    expect(lintPatch(p, features(p), project).judgement).toEqual(judgement);
    expect(lintPatch(p, features(p, { dcOffset: 1 }), project).judgement).toEqual(judgement);
  });
});

const member = (name: string, family: string, priority: number, over: Partial<Features> = {}): KitMember => {
  const p = patch({ schema: 'beeps/patch@1', name, family, duration: 0.3,
    layers: [{ source: { type: 'osc', wave: 'sine', pitch: 'C5' }, amp: { attack: 0.005, decay: 0.2 } }] });
  return { patch: p, features: features(p, over), priority };
};

describe('lintKit', () => {
  // Distinct dominant bands keep masking-risk quiet unless a test wants it.
  const band = (k: number) => Array.from({ length: 8 }, (_, i) => (i === k ? -1 : -30));
  const clean = () => [
    member('coin', 'coin', 2, { centroidHz: 3000, bands: band(5) }),
    member('no', 'no', 1, { centroidHz: 600, bands: band(3) }),
    member('jump', 'jump', 3, { centroidHz: 1200, bands: band(4) }),
  ];

  it('passes a clean kit', () => {
    const r = lintKit(clean(), project);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('errors on two "no" sounds and warns on none', () => {
    const two = [...clean(), member('no-2', 'no', 1, { centroidHz: 700, bands: band(2) })];
    expect(rulesOf(lintKit(two, project).errors)).toContain('one-no');
    const none = clean().filter(m => m.patch.family !== 'no');
    const r = lintKit(none, project);
    expect(rulesOf(r.errors)).not.toContain('one-no');
    expect(rulesOf(r.warnings)).toContain('one-no');
  });

  it('errors on six priority levels', () => {
    const six = [1, 2, 3, 4, 5, 6].map(n => member(`s${n}`, n === 1 ? 'no' : `fam${n}`, n, { centroidHz: 100 * 2 ** n, bands: band(n) }));
    expect(rulesOf(lintKit(six, project).errors)).toContain('priority-levels');
    expect(rulesOf(lintKit(six.slice(0, 5), project).errors)).not.toContain('priority-levels');
  });

  it('warns when a family spans more than an octave', () => {
    const kit = [...clean(), member('coin-2', 'coin', 2, { centroidHz: 7000, bands: band(6) })];
    expect(rulesOf(lintKit(kit, project).warnings)).toContain('family-consistency');
  });

  it('warns when a pitched member is out of key', () => {
    // C major pentatonic has no F#; 740 Hz (F#5) is 100 cents from E5/G5.
    const kit = [...clean(), member('chime', 'confirm', 2, { centroidHz: 5000, bands: band(7), pitchHz: 739.99, pitchStrength: 0.9 })];
    expect(rulesOf(lintKit(kit, project).warnings)).toContain('key-consistency');
    const inKey = [...clean(), member('chime', 'confirm', 2, { centroidHz: 5000, bands: band(7), pitchHz: 659.26, pitchStrength: 0.9 })];
    expect(rulesOf(lintKit(inKey, project).warnings)).not.toContain('key-consistency');
  });

  it('warns on masking risk for close centroids in the same band', () => {
    const kit = [...clean(), member('blip', 'blip', 3, { centroidHz: 3300, bands: band(5) })];
    const r = lintKit(kit, project);
    expect(r.warnings).toContainEqual(expect.objectContaining({ rule: 'masking-risk', message: expect.stringMatching(/coin and blip/) }));
  });

  it('always lists the kit judgement rules', () => {
    const judgement = loadRules().filter(r => r.check === 'judgement' && r.appliesTo === 'kit').map(r => r.id);
    expect(judgement).toContain('one-meaning-per-sound');
    expect(lintKit(clean(), project).judgement).toEqual(judgement);
    expect(lintKit([], project).judgement).toEqual(judgement);
  });
});

describe('craft/rules.json', () => {
  const rules = loadRules();

  it('has the v1 rule ids, each unique', () => {
    const ids = rules.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['true-peak-ceiling', 'attack-floor', 'no-dc', 'no-clipping', 'nyquist', 'tick-length', 'tail-ceiling',
      'sharpness-warn', 'roughness-warn', 'variation-on-repeating', 'loudness-target', 'one-no', 'priority-levels',
      'family-consistency', 'key-consistency', 'masking-risk', 'silent-not-quiet', 'one-meaning-per-sound',
      'reverb-preset-only', 'synthesis-choice']) expect(ids).toContain(id);
  });

  it('cites at least one https source per rule', () => {
    for (const r of rules) {
      expect(r.sources.length, r.id).toBeGreaterThan(0);
      for (const s of r.sources) {
        expect(s.url, r.id).toMatch(/^https:\/\//);
        expect(s.title.length, r.id).toBeGreaterThan(0);
      }
    }
  });

  it('stands alone: no wikilinks or vault references anywhere in craft/', () => {
    const dir = join(import.meta.dirname, '..', 'craft');
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/\[\[|wiki-master/);
    }
  });
});

describe('variantSiblings', () => {
  const named = (name: string, family: string, meta?: Record<string, unknown>) => patch({ ...coin(), name, family, ...(meta ? { meta } : {}) });

  it('groups <stem>-<n> names within one family', () => {
    const s = variantSiblings([named('explosion-0', 'explosion'), named('explosion-1', 'explosion'), named('explosion-2', 'explosion'), named('explosion-3', 'explosion')]);
    expect(s.get('explosion-0')).toEqual(['explosion-1', 'explosion-2', 'explosion-3']);
  });

  it('groups by meta.variantOf whatever the names, and keeps families apart', () => {
    const s = variantSiblings([
      named('boom-near', 'explosion', { variantOf: 'boom' }), named('boom-far', 'explosion', { variantOf: 'boom' }),
      named('coin-1', 'coin'), named('coin-2', 'pickup'), named('ui-click-2', 'ui-click'),
    ]);
    expect(s.get('boom-near')).toEqual(['boom-far']);
    expect(s.get('coin-1')).toEqual([]);
    expect(s.get('ui-click-2')).toEqual([]);
  });

  it('counts a patch once when it appears twice', () => {
    expect(variantSiblings([named('hit-1', 'hit'), named('hit-1', 'hit'), named('hit-2', 'hit')]).get('hit-1')).toEqual(['hit-2']);
  });
});

describe('kitRuleNotes', () => {
  const named = (name: string, family: string) => patch({ ...coin(), name, family });

  it('says kit-level rules run only in kit check when a linted patch is in the kit or has family members', () => {
    const notes = kitRuleNotes([named('explosion-2', 'explosion')], [named('explosion-1', 'explosion'), named('pickup', 'pickup')], ['pickup']);
    expect(notes).toHaveLength(1);
    expect(notes[0].rule).toBe('kit-rules');
    expect(notes[0].message).toMatch(/family-consistency.*masking-risk.*key-consistency.*one-no/s);
    expect(notes[0].message).toMatch(/beeps kit add <name> for each of explosion-1, explosion-2,/);
    expect(notes[0].message).toMatch(/beeps kit check/);
    const inKit = kitRuleNotes([named('pickup', 'pickup')], [], ['pickup']);
    expect(inKit[0].message).toMatch(/pickup is in the kit/);
    expect(inKit[0].message).not.toMatch(/kit add/);
  });

  it('says nothing for a lone patch outside the kit', () => {
    expect(kitRuleNotes([named('coin', 'coin')], [named('pickup', 'pickup')], [])).toEqual([]);
  });
});

describe('effectTailNotes', () => {
  const verb = () => patch({ ...coin(), name: 'pickup', family: 'pickup', fx: { reverb: { preset: 'small', sendDb: -22 } } });

  it('notes a long quiet effect tail that tail-ceiling lets through, and how to trim it', () => {
    const p = verb();
    const notes = effectTailNotes(p, features(p, { durationSec: 0.735, energyLengthSec: 0.25, tailSec: 0.6 }));
    expect(notes).toEqual([expect.objectContaining({ rule: 'effect-tail', name: 'pickup', message: expect.stringMatching(/0\.485 s of the 0\.735 s render.*--trim-tail -60/) })]);
  });

  it('says nothing without an effect or when the tail is short', () => {
    const p = verb();
    expect(effectTailNotes(coin(), features(coin(), { durationSec: 0.735, energyLengthSec: 0.25 }))).toEqual([]);
    expect(effectTailNotes(p, features(p, { durationSec: 0.4, energyLengthSec: 0.3 }))).toEqual([]);
  });

  it('tail-ceiling names the audible length beside the -60 dB tail', () => {
    const p = verb();
    const w = lintPatch(p, features(p, { tailSec: 1.5, energyLengthSec: 0.3 }), project).warnings.find(x => x.rule === 'tail-ceiling');
    expect(w?.message).toMatch(/tail 1\.5 s exceeds the 0\.8 s ceiling.*0\.3 s within 40 dB of peak.*--trim-tail/);
  });
});
