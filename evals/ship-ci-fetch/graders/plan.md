---
type: llm
---
The plan (a) describes a build config (`beeps.build.json`) whose recipes map ids to sources, (b) uses `beeps build` so unchanged inputs are never re-rendered, (c) commits the lock file, not the rendered audio, (d) publishes the built assets to a content-addressed store (`beeps build --push` or `beeps store push`) and has CI fetch from that store by hash, for example with the vendored `fetch.mjs` from `beeps ci export`, instead of rendering, and (e) keeps the CI job free of Chromium and ffmpeg. Fail if CI still renders every sound, if rendered audio is committed in place of a lock, or if the plan never mentions a store or fetch step.
