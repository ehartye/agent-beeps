// Rendering for expectations: a patch with an `xExpect` block is checked on every variant it declares, so the renders for the extra
// variants ride in the same batch as the ones the caller asked for. The commands that already render (lint, kit check, build) call this.
import { evaluateExpectations, expectationVariants, type ExpectationReport } from './expect.ts';
import type { RenderHost } from './render/host.ts';
import { renderAndMeasure, type PipelineItem, type RenderOutcome } from './render/pipeline.ts';
import type { RenderOptions } from './render/options.ts';

/** `renderAndMeasure` for `items` (variant 0 unless the item says otherwise), plus each expectation verdict for the items whose patch has one. */
export async function renderWithExpectations(host: RenderHost, items: PipelineItem[], opts: RenderOptions): Promise<{ outcomes: RenderOutcome[]; expectations: (ExpectationReport | undefined)[] }> {
  const extra = items.flatMap((it, owner) => (it.patch.xExpect
    ? Array.from({ length: expectationVariants(it.patch) - 1 }, (_, v) => ({ owner, item: { ...it, variant: v + 1 } }))
    : []));
  const out = await renderAndMeasure(host, [...items, ...extra.map(x => x.item)], opts);
  const outcomes = out.slice(0, items.length);
  const expectations = items.map((it, i) => {
    const main = outcomes[i];
    if (!it.patch.xExpect || !main.ok) return undefined;
    const rest = extra.map((x, k) => ({ x, o: out[items.length + k] })).filter(({ x }) => x.owner === i);
    const report = evaluateExpectations(it.patch, [main.features, ...rest.flatMap(({ o }) => (o.ok ? [o.features] : []))]);
    // A variant that would not render cannot have been checked: that is a failure of the contract, not a smaller set of variants.
    const unrendered = rest.flatMap(({ x, o }) => (o.ok ? [] : [x.item.variant]));
    return unrendered.length ? { ...report, passed: false, unrendered } : report;
  });
  return { outcomes, expectations };
}
