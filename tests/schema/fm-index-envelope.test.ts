import { describe, expect, it } from 'vitest';
import { parsePatch, patchJsonSchema } from '../../src/schema/patch.ts';

const envPointer = '/layers/0/source/operators/1/indexEnv';
const fm = (indexEnv?: unknown) => ({
  schema: 'beeps/patch@1', name: 'fm-envelope', family: 'test', duration: 0.6,
  layers: [{
    source: {
      type: 'fm', pitch: 200,
      operators: [{ ratio: 1 }, { ratio: 2, index: 4, ...(indexEnv === undefined ? {} : { indexEnv }) }],
      algorithm: [[1, 0]],
    },
    amp: {},
  }],
});
const issues = (input: unknown) => {
  const result = parsePatch(input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues;
};

describe('FM index envelope authoring', () => {
  it('accepts normalized breakpoint scales and preserves omitted arrival curves', () => {
    const indexEnv = [[0, 0], [0.006, 1], [0.15, 0.2, 'exp'], [0.3, 0.4, 'step'], [0.6, 0, 'linear']];
    const result = parsePatch(fm(indexEnv));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const source = result.patch.layers[0].source;
    expect(source.type).toBe('fm');
    if (source.type !== 'fm') return;
    expect(source.operators[1]).toMatchObject({ index: 4, indexEnv });
    expect(JSON.stringify(source.operators[1])).toContain('[[0,0],[0.006,1],');
    expect(Object.hasOwn(source.operators[1].indexEnv![0], 2)).toBe(false);
  });

  it('leaves the envelope field absent on legacy operators', () => {
    const result = parsePatch(fm());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.patch)).not.toContain('indexEnv');
  });

  it.each([
    { indexEnv: [[0, 0]] },
    { indexEnv: [[0, 1]] },
    { indexEnv: Array.from({ length: 64 }, (_, i) => [i * 10 / 63, i / 63]) },
  ])('accepts a single held value or the 64 point / 10 second boundary: $indexEnv', ({ indexEnv }) => {
    expect(parsePatch(fm(indexEnv)).ok).toBe(true);
  });

  it.each([
    { name: 'empty', env: [], pointer: envPointer },
    { name: '65 points', env: Array.from({ length: 65 }, (_, i) => [i / 64, 1]), pointer: envPointer },
    { name: 'nonzero start', env: [[0.01, 0]], pointer: `${envPointer}/0/0` },
    { name: 'negative time', env: [[0, 0], [-0.1, 1]], pointer: `${envPointer}/1/0` },
    { name: 'time above ten seconds', env: [[0, 0], [10.01, 1]], pointer: `${envPointer}/1/0` },
    { name: 'duplicate time', env: [[0, 0], [0, 1]], pointer: `${envPointer}/1/0` },
    { name: 'descending time', env: [[0, 0], [0.2, 1], [0.1, 0]], pointer: `${envPointer}/2/0` },
    { name: 'infinite time', env: [[0, 0], [Infinity, 1]], pointer: `${envPointer}/1/0` },
    { name: 'NaN time', env: [[0, 0], [NaN, 1]], pointer: `${envPointer}/1/0` },
    { name: 'negative scale', env: [[0, -0.01]], pointer: `${envPointer}/0/1` },
    { name: 'scale above one', env: [[0, 1.01]], pointer: `${envPointer}/0/1` },
    { name: 'infinite scale', env: [[0, Infinity]], pointer: `${envPointer}/0/1` },
    { name: 'NaN scale', env: [[0, NaN]], pointer: `${envPointer}/0/1` },
    { name: 'unknown arrival', env: [[0, 0], [0.1, 1, 'spline']], pointer: `${envPointer}/1/2` },
    { name: 'extra tuple member', env: [[0, 0, 'linear', 'extra']], pointer: `${envPointer}/0` },
    { name: 'missing scale', env: [[0]], pointer: `${envPointer}/0` },
    { name: 'exponential ramp from zero', env: [[0, 0], [0.1, 1, 'exp']], pointer: `${envPointer}/1/2` },
    { name: 'exponential ramp to zero', env: [[0, 1], [0.1, 0, 'exp']], pointer: `${envPointer}/1/2` },
  ])('rejects $name at the authored point', ({ env, pointer }) => {
    expect(issues(fm(env))).toEqual(expect.arrayContaining([expect.objectContaining({ pointer })]));
  });

  it('rejects an envelope on an operator with no outgoing modulation edge', () => {
    const input = fm();
    Object.assign(input.layers[0].source.operators[0], { indexEnv: [[0, 1]] });
    expect(issues(input)).toEqual(expect.arrayContaining([expect.objectContaining({
      pointer: '/layers/0/source/operators/0/indexEnv', message: expect.stringMatching(/outgoing modulation edge/),
    })]));
  });

  it.each([{ algorithm: [[1, 1]] }, { algorithm: [[1, 3]] }])('does not count ignored self or out-of-range edges as outgoing: $algorithm', ({ algorithm }) => {
    const input = fm([[0, 1]]);
    input.layers[0].source.algorithm = algorithm;
    expect(issues(input)).toEqual(expect.arrayContaining([expect.objectContaining({ pointer: envPointer })]));
  });

  it('includes the optional envelope shape in the published JSON Schema', () => {
    const schema = patchJsonSchema() as any;
    const source = schema.properties.layers.items.properties.source.oneOf.find((s: any) => s.properties.type.const === 'fm');
    const operator = source.properties.operators.items;
    expect(operator.properties.indexEnv).toMatchObject({ type: 'array', minItems: 1, maxItems: 64 });
    expect(operator.required).not.toContain('indexEnv');
  });
});

describe('FM index envelopes at runtime input corners', () => {
  const bound = (target: string, range: number[], clamp?: number[]) => ({
    ...fm([[0, 1], [0.1, 0.25, 'exp']]),
    xRuntime: {
      inputs: { energy: { min: 0, max: 1, default: 0.5 } },
      bind: [{ input: 'energy', target, range, ...(clamp ? { clamp } : {}) }],
    },
  });

  it('keeps index as the peak, including a mapped zero peak', () => {
    expect(parsePatch(bound('/layers/0/source/operators/1/index', [-4, 4])).ok).toBe(true);
  });

  it.each([
    { target: `${envPointer}/0/0`, range: [0, 0.01], invalid: `${envPointer}/0/0` },
    { target: `${envPointer}/1/0`, range: [-0.2, 0.2], invalid: `${envPointer}/1/0` },
    { target: `${envPointer}/1/1`, range: [-0.5, 0.5], invalid: `${envPointer}/1/1` },
    { target: `${envPointer}/1/1`, range: [-0.25, 0.25], invalid: `${envPointer}/1/2` },
    { target: '/layers/0/source/algorithm/0/0', range: [-1, 1], invalid: envPointer },
  ])('rejects mapped corners that violate $invalid', ({ target, range, invalid }) => {
    expect(issues(bound(target, range))).toEqual(expect.arrayContaining([expect.objectContaining({
      pointer: '/xRuntime/bind', message: expect.stringContaining(invalid),
    })]));
  });

  it('accepts a binding clamped to valid positive exponential scales', () => {
    expect(parsePatch(bound(`${envPointer}/1/1`, [-1, 1], [0.01, 1])).ok).toBe(true);
  });
});
