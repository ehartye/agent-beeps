import { describe, expect, it } from 'vitest';
import { renderKey } from '../../src/hash.ts';
import { customLoudnessOffset, FAMILY_OFFSETS, PIPELINE_VERSION, patchRenderKey, targetFor } from '../../src/render/pipeline.ts';
import { parsePatch } from '../../src/schema/patch.ts';
import { defaultProject, parseProject } from '../../src/schema/project.ts';
import { coin, patch } from '../helpers/patches.ts';

const step = (meta?: Record<string, unknown>) => patch({ ...coin(), name: 'step', family: 'footstep', ...(meta ? { meta } : {}) });
const withOffsets = (familyOffsets: Record<string, number>) => parseProject({ schema: 'beeps/project@1', familyOffsets });

describe('per-family loudness offsets', () => {
  it('leaves targets and render keys exactly as before when no offset is set', () => {
    const project = defaultProject();
    expect(project).not.toHaveProperty('familyOffsets');
    for (const p of [coin(), step(), patch({ ...coin(), family: 'hit' })]) {
      const stock = project.targetLoudness + (FAMILY_OFFSETS[p.family] ?? 0);
      expect(targetFor(p, project)).toBe(stock);
      // The formula render keys used before offsets could be configured.
      expect(patchRenderKey(p, project, 1, 0)).toBe(renderKey(p, { seed: 1, variant: 0, scale: project.scale, target: stock, pipeline: PIPELINE_VERSION }));
      expect(customLoudnessOffset(p, project)).toBeUndefined();
    }
    // Pinned: a change here re-renders every approved one-shot.
    expect(patchRenderKey(coin(), project, 1, 0)).toBe(renderKey(coin(), { seed: 1, variant: 0, scale: project.scale, target: -19, pipeline: PIPELINE_VERSION }));
  });

  it('moves a family through project config, over the stock table, and only that family', () => {
    const project = withOffsets({ footstep: -6, coin: 0 });
    expect(targetFor(step(), project)).toBe(-24);
    expect(targetFor(coin(), project)).toBe(-18); // the stock -1 is replaced by an explicit 0
    expect(targetFor(patch({ ...coin(), family: 'hit' }), project)).toBe(-17);
    expect(patchRenderKey(step(), project, 1, 0)).not.toBe(patchRenderKey(step(), defaultProject(), 1, 0));
    expect(patchRenderKey(patch({ ...coin(), family: 'hit' }), project, 1, 0)).toBe(patchRenderKey(patch({ ...coin(), family: 'hit' }), defaultProject(), 1, 0));
  });

  it('adds a patch meta offset on top of its family offset', () => {
    const project = withOffsets({ footstep: -6 });
    const soft = step({ loudnessOffsetDb: -3 });
    expect(targetFor(soft, project)).toBe(-27);
    expect(targetFor(soft, defaultProject())).toBe(-21);
    expect(customLoudnessOffset(soft, project)).toBe(-9);
    expect(customLoudnessOffset(step(), project)).toBe(-6);
    // A stock family moved by a project entry reports the move from stock, not the stock offset.
    expect(customLoudnessOffset(coin(), withOffsets({ coin: -4 }))).toBe(-3);
  });

  it('validates the project table and the patch field', () => {
    expect(() => withOffsets({ footstep: -40 })).toThrow();
    expect(() => parseProject({ schema: 'beeps/project@1', familyOffsets: { footstep: 'quiet' } })).toThrow();
    const bad: any = step();
    bad.meta = { loudnessOffsetDb: 20 };
    expect(parsePatch(bad).ok).toBe(false);
    const ok = parsePatch({ ...coin(), meta: { loudnessOffsetDb: -4 } });
    expect(ok.ok && ok.patch.meta?.loudnessOffsetDb).toBe(-4);
    expect(JSON.stringify(parsePatch(coin()))).not.toContain('loudnessOffsetDb');
  });
});
