# Releasing agent-beeps

A release is one version, stamped in five places, published as a tag, a release, a commit on the `runtime` branch and an
entry in the marketplace repository that lists the plugin. `node scripts/release-check.mjs` verifies the parts it can.

## Before the pull request

1. Pick the version. A new command, rule or option is a minor bump; a fix with no new surface is a patch.
2. Stamp it in `package.json`, `package-lock.json` (two places: the top-level `version` and `packages[""]`),
   `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and add `## What changed in <version>` to the
   README. The plugin descriptor's `description` is the source of truth: `package.json` and `marketplace.json` repeat it.
   `tests/release.test.ts` fails when any of these disagree.
3. Regenerate what the change touched, each with its own command:
   - a library patch or engine change: `node scripts/golden-graphs.mjs --write` (the moved cases are the review: say which in the
     commit) and `node scripts/build-ci-fetch.mjs --write`;
   - a command added, renamed or re-described: `node scripts/gen-cli-docs.mjs --write`;
   - an engine file, a bundled library file or a booth input: `npm run showcase:render`, then restore any media you did not mean to
     change (see the Fuse drift note in the wiki), and check `npm run showcase:build` reports every hash verified.
4. Run `npm run typecheck`, `npx vitest run --maxWorkers=2` (the whole suite; CI also runs it on Ubuntu) and, with Chromium installed,
   `npm run showcase:test` (from PowerShell on Windows: the Fuse test shells out to `tar`).

## Full-suite CI coverage

`tests.yml` runs every Vitest test on pull requests, main pushes and manual dispatch, with two workers and a 25-minute job timeout. It installs locked dependencies without scripts, explicitly rebuilds the approved `ffmpeg-static` binary, installs Chromium and its Linux dependencies, then requires working offline audio plus MP3/Opus encoders. Missing prerequisites fail before the suite; they cannot silently skip render/codec coverage. Existing `pages.yml` and the Linux/Windows audition ownership jobs remain separate.

The JSON result is retained for seven days and a job summary names skips. This Chromium lane intentionally does not install Firefox: the three Firefox parity/decoding/selftest cases may skip. The four bundle file-link/permission controls may skip only when their test detects an unsupported host capability. Those exact cases are enumerated in `scripts/ci-suite.mjs`; new skips fail until deliberately reviewed. Golden graph and hygiene tests must be present and pass. This is not Safari/iOS qualification or a full-suite Windows lane.

Local equivalent after installing the required runtimes:

```text
node scripts/ci-suite.mjs preflight
npm test -- --maxWorkers=2 --reporter=default --reporter=json --outputFile=.local/ci/vitest.json
node scripts/ci-suite.mjs report .local/ci/vitest.json
```

## Publish

1. Open the pull request; wait for CI; squash-merge it with a hand-written message.
2. On a clean checkout of `main`: `node scripts/build-runtime-package.mjs --publish`, then `git push origin runtime`. The branch is
   append-only (games pin its commits): never force-push it. A release that changes no engine file adds a version-stamp commit.
3. `gh release create v<version> --target main --title "agent-beeps <version>" --notes-file <notes>`. Notes: a short "What changed"
   list, the source pull request, and the runtime commit.
4. In the marketplace repository, open a pull request that updates only the `agent-beeps` entry's version, release tag and exact source SHA (its `description` must
   already equal the plugin descriptor's). Merge it.
5. Confirm the Pages run for the merge commit succeeded and the booth answers (page 200, a media file 206, the manifest entry count).
6. `node scripts/release-check.mjs --remote`: the tag points at `origin/main` and `origin/runtime` carries the version.

## Not part of a release

Plugin caches on other machines update on their own schedule; reinstall or update the plugin to pick up a version.
