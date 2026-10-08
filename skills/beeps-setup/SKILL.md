---
name: beeps-setup
description: Install, check and repair the managed agent-beeps runtime (Node dependencies and Chromium for offline audio renders) outside the plugin cache.
when_to_use: Use before the first beeps command in a session, after a plugin update, or when a beeps skill reports "Managed CLI ... is missing", "rerun beeps-setup", E_BROWSER_MISSING, E_RUNTIME_MISSING, or a runtime version mismatch.
---

# agent-beeps setup

The plugin cache is a bare checkout with no dependencies. Setup copies the runtime into
`~/.agent-beeps/releases/<version-hash-platform>`, installs lockfile dependencies, installs
Chromium for Playwright (every sound is rendered by the browser's own Web Audio engine), links the
CLI, and writes a receipt. Every other beeps skill runs the launcher, which refuses anything but
that release. Node.js 24 or newer with npm must already be installed; the CLI runs TypeScript
directly.

Resolve `<plugin-root>` from this file: two directories above its `beeps-setup` directory. Use the
absolute path. Commands below write `beeps` for `node "<plugin-root>/scripts/run-managed.js"`.

## Steps

1. Check: `node "<plugin-root>/scripts/setup.js" --check --json`.
2. If `ok` is false, install: `node "<plugin-root>/scripts/setup.js" --json`. The first run takes a
   few minutes (dependencies and the Chromium download). Stop on failure and show the error; never
   install into the plugin cache.
3. Check again and require `ok: true`. Report `cliVersion` and `runtimeRoot`.
3b. Optional, for cross-browser delivery checks (`beeps loopcheck --engines`): `node "<plugin-root>/scripts/setup.js" --json --browsers firefox,webkit`.
4. Smoke test: `beeps capabilities --no-schema` lists source types, archetypes and error codes.

## Where things live

- `~/.agent-beeps/` (`AGENT_BEEPS_HOME` moves it): managed releases, the audition server's
  `server.json` (port and access token), and the owner's global taste log in `taste/`.
- `<project>/.agent-beeps/`: that project's patches, kit, candidate sets, audition sessions,
  project taste layer, and a git-ignored render cache. Create it with `beeps init`.

## Done bar

`setup.js --check --json` reports `ok: true` and `beeps capabilities` answers. If the owner's other
machines cannot open audition links, the firewall must allow inbound connections to Node on the
audition port (default 47301); say so rather than changing firewall rules yourself.
