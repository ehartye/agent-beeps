// A canonical, order-preserving dump of a graph built on the recording FakeContext: every node in creation order with its
// scalar properties, its AudioParams (value and scheduled events) and its connections as indices. Two builders that make
// the same sound should produce the same dump; this is what the codegen tests compare.
import { FakeNode, FakeParam, type FakeContext } from './fake-context.ts';

const sum = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * ((i % 7) + 1); return Math.round(s * 1e6) / 1e6; };

export function dumpGraph(f: FakeContext): unknown[] {
  const nodes = [f.destination, ...f.created];
  const index = new Map<unknown, string>();
  nodes.forEach((n, i) => {
    index.set(n, `n${i}`);
    for (const [k, v] of Object.entries(n)) if (v instanceof FakeParam) index.set(v, `n${i}.${k}`);
  });
  return nodes.map((n, i) => {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === 'ctx' || k === 'outputs' || k === 'kind') continue;
      if (v instanceof FakeParam) props[k] = { value: v.value, events: v.events };
      else if (v && typeof v === 'object' && 'getChannelData' in (v as object)) {
        const b = v as { numberOfChannels: number; length: number; sampleRate: number; getChannelData(c: number): Float32Array };
        props[k] = { buffer: [b.numberOfChannels, b.length, b.sampleRate, ...Array.from({ length: b.numberOfChannels }, (_, c) => sum(b.getChannelData(c)))] };
      } else if (v instanceof Float32Array) props[k] = { f32: sum(v) };
      else if (typeof v === 'function') continue;
      else if (v && typeof v === 'object') props[k] = JSON.stringify(v, (_k, x) => (x instanceof Float32Array ? sum(x) : x));
      else props[k] = v;
    }
    return { i, kind: (n as FakeNode).kind, ...props, out: n.outputs.map(o => index.get(o) ?? '?') };
  });
}
