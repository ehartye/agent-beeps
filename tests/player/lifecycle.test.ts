// tests/player/lifecycle.test.ts
import { expect, it } from 'vitest';
import { createLifecycle } from '../../runtime/player/lifecycle.js';

function context() {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const ctx = {
    state: 'suspended',
    async resume() { calls.push('resume'); this.state = 'running'; },
    async suspend() { calls.push('suspend'); await gate; this.state = 'suspended'; },
  };
  return { ctx, calls, release };
}

it('applies rapid hide and show in order, ending in the latest state', async () => {
  const { ctx, calls, release } = context();
  const life = createLifecycle(ctx as unknown as AudioContext);
  await life.reconcile();
  const hide = life.setHidden(true);
  const show = life.setHidden(false);
  release();
  await Promise.all([hide, show]);
  expect(calls).toEqual(['resume', 'suspend', 'resume']);
  expect(ctx.state).toBe('running');
});

it('allow() re-enables without resuming until the next reconcile', async () => {
  const { ctx, calls, release } = context();
  release();
  const life = createLifecycle(ctx as unknown as AudioContext, { enabled: false });
  await life.reconcile();
  life.allow();
  expect(life.running).toBe(true);
  expect(calls).toEqual(['suspend']);
  await life.reconcile();
  expect(calls).toEqual(['suspend', 'resume']);
});
