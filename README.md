# agent-beeps-runtime

Generated from [agent-beeps](https://github.com/ehartye/agent-beeps) by `scripts/build-runtime-package.mjs`. Do not edit.

The browser-safe runtime: files byte-identical to their sources, no dependencies for the engine (`zod` only for the schema
entry). The engine entry is plain JavaScript with `.d.ts` types; the schema entry is TypeScript source, so import it with a
bundler or runner that accepts `.ts`.

```js
import { build, parseCue, createReverbBus } from 'agent-beeps-runtime';
import { parsePatch } from 'agent-beeps-runtime/schema'; // only to parse raw patch JSON; cues are already parsed

const voice = build(ctx, ctx.destination, parseCue(cueJson), { params: { speed: 0.4 } }).start();
voice.set('speed', 0.9);
voice.stop();
```

See docs/runtime.md in agent-beeps for the API, inputs, the shared reverb bus and what to measure.
