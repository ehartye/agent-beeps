// tests/player/voices.test.ts
import { describe, expect, it } from 'vitest';
import { createVoiceManager } from '../../runtime/player/voices.js';

const opts = (priority = 3, over = {}) => ({ priority, cooldownSec: 0, cap: 3, ...over });

describe('voice manager', () => {
  it('grants voices up to the budget, then drops equally or less important requests', () => {
    const vm = createVoiceManager({ budget: 2 });
    expect(vm.request('a', opts(), 0)).toMatchObject({ steal: null });
    expect(vm.request('b', opts(), 0.1)).toMatchObject({ steal: null });
    expect(vm.request('c', opts(3), 0.2)).toBeNull();
    expect(vm.request('c', opts(5), 0.3)).toBeNull();
    expect(vm.size).toBe(2);
  });

  it('lets a more important sound (smaller number) steal the oldest less important voice', () => {
    const vm = createVoiceManager({ budget: 2 });
    // a is the oldest less important voice; b is less important still but newer: the rule picks age.
    const a = vm.request('a', opts(2), 0)!;
    vm.request('b', opts(4), 0.1);
    const hit = vm.request('hit', opts(1), 0.2)!;
    expect(hit.steal).toBe(a.key);
    expect(vm.has(a.key)).toBe(false);
    expect(vm.size).toBe(2);
  });

  it('holds a cooldown per sound', () => {
    const vm = createVoiceManager({ budget: 8 });
    expect(vm.request('coin', opts(3, { cooldownSec: 0.05 }), 1)).not.toBeNull();
    expect(vm.request('coin', opts(3, { cooldownSec: 0.05 }), 1.02)).toBeNull();
    expect(vm.request('coin', opts(3, { cooldownSec: 0.05 }), 1.06)).not.toBeNull();
  });

  it('replaces the oldest instance of a sound at its instance cap', () => {
    const vm = createVoiceManager({ budget: 8 });
    const first = vm.request('step', opts(3, { cap: 2 }), 0)!;
    vm.request('step', opts(3, { cap: 2 }), 0.1);
    const third = vm.request('step', opts(3, { cap: 2 }), 0.2)!;
    expect(third.steal).toBe(first.key);
    expect(vm.size).toBe(2);
  });

  it('frees a slot on release and on clear', () => {
    const vm = createVoiceManager({ budget: 1 });
    const a = vm.request('a', opts(), 0)!;
    vm.release(a.key);
    expect(vm.request('b', opts(), 0.1)).not.toBeNull();
    vm.clear();
    expect(vm.size).toBe(0);
  });
});
