// A recording stand-in for BaseAudioContext: enough of Web Audio to build graphs and inspect them.

type Event = { kind: string; value: number; time: number; extra?: number };

export class FakeParam {
  value: number;
  events: Event[] = [];
  constructor(value = 0) { this.value = value; }
  setValueAtTime(value: number, time: number) { this.events.push({ kind: 'set', value, time }); return this; }
  linearRampToValueAtTime(value: number, time: number) { this.events.push({ kind: 'linear', value, time }); return this; }
  exponentialRampToValueAtTime(value: number, time: number) {
    if (!(value > 0)) throw new RangeError(`exponential ramp to ${value}`); // real browsers throw too
    this.events.push({ kind: 'exponential', value, time }); return this;
  }
  setTargetAtTime(value: number, time: number, extra: number) { this.events.push({ kind: 'target', value, time, extra }); return this; }
  cancelScheduledValues(time: number) { this.events.push({ kind: 'cancel', value: 0, time }); return this; }
}

export class FakeNode {
  kind: string;
  ctx: FakeContext;
  outputs: (FakeNode | FakeParam)[] = [];
  [key: string]: any;
  constructor(ctx: FakeContext, kind: string, params: Record<string, number> = {}) {
    this.ctx = ctx; this.kind = kind;
    for (const [k, v] of Object.entries(params)) this[k] = new FakeParam(v);
  }
  connect<T extends FakeNode | FakeParam>(target: T): T { this.outputs.push(target); return target; }
  start(t = 0, offset = 0) { this.startedAt = t; this.offset = offset; }
  stop(t = 0) { this.stoppedAt = t; }
  disconnect(target?: FakeNode | FakeParam) {
    if (target) this.outputs = this.outputs.filter(o => o !== target);
    else this.disconnected = true;
  }
}

export class FakeContext {
  sampleRate = 48000;
  currentTime = 0;
  created: FakeNode[] = [];
  destination: FakeNode;
  state = 'suspended';
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async decodeAudioData(_: ArrayBuffer) { return this.createBuffer(2, 4800, 48000); }
  constructor() { this.destination = new FakeNode(this, 'destination'); }
  private make(kind: string, params: Record<string, number> = {}) { const n = new FakeNode(this, kind, params); this.created.push(n); return n; }
  createOscillator() { const n = this.make('osc', { frequency: 440, detune: 0 }); n.type = 'sine'; return n; }
  createGain() { return this.make('gain', { gain: 1 }); }
  createBiquadFilter() { const n = this.make('biquad', { frequency: 350, Q: 1, gain: 0, detune: 0 }); n.type = 'lowpass'; return n; }
  createBufferSource() { const n = this.make('bufferSource', { playbackRate: 1, detune: 0 }); n.loop = false; return n; }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (c: number) => data[c] };
  }
  createWaveShaper() { return this.make('shaper'); }
  createStereoPanner() { return this.make('panner', { pan: 0 }); }
  createConvolver() { return this.make('convolver'); }
  createDynamicsCompressor() { return this.make('compressor', { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }); }
  createDelay() { return this.make('delay', { delayTime: 0 }); }
  createIIRFilter(feedforward: number[], feedback: number[]) { const n = this.make('iir'); n.feedforward = feedforward; n.feedback = feedback; return n; }
  createChannelMerger() { return this.make('merger'); }
  nodes(kind: string) { return this.created.filter(n => n.kind === kind); }
  /** The most connections any one node input or AudioParam receives (Chromium sums 3+ in a per-run order). */
  maxFanIn() {
    const n = new Map<object, number>();
    for (const node of this.created) for (const o of node.outputs) n.set(o, (n.get(o) ?? 0) + 1);
    return Math.max(0, ...n.values());
  }
  count(kind: string) { return this.nodes(kind).length; }
  /** Every scheduled automation value of a kind, across all params of all nodes. */
  rampTargets(kind: string) {
    const out: number[] = [];
    for (const n of this.created) for (const v of Object.values(n)) if (v instanceof FakeParam) for (const e of v.events) if (e.kind === kind) out.push(e.value);
    return out;
  }
}

export const asCtx = (f: FakeContext) => f as unknown as BaseAudioContext;
