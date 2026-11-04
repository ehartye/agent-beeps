# Check with the locked toolchain

Project wrappers must not choose the newest installed plugin to verify an older
audio lock. Use the current plugin's explicit check-only launcher route:

```text
node "<plugin-root>/scripts/run-managed.js" --locked-build-check "<project>/beeps.build.json"
```

It selects an installed managed runtime whose complete seven-field toolchain
matches the lock, verifies its receipt, full source fingerprint and platform/ABI,
then runs only `build --config <absolute-config> --check` (JSON is the CLI default). Selection is
reported on stderr; the checker's JSON stdout and exit status are preserved.
The checker still hashes recipe inputs and every delivered output. It does not
render, fetch, adopt, rewrite a lock or repair a runtime. Additional build flags
are rejected. Ordinary launcher/setup behavior remains unchanged.

The lock intentionally records sound-affecting versions, not a package version or
Git revision. Compatible selection is not proof of the original producer. If the
loaded plugin's runtime is compatible it wins; otherwise a unique compatible
installation is required. Multiple matches refuse rather than choosing newest.
For a separately declared project/CI source pin, use:

```text
node "<plugin-root>/scripts/run-managed.js" --locked-build-check "<project>/beeps.build.json" --runtime-source "<absolute-trusted-pinned-plugin-root>"
```

This resolves that source's exact fingerprinted installation and refuses a
toolchain mismatch without falling back. A version string alone is not provenance;
obtain the trusted source revision declared by the project. Discovery reads only
`AGENT_BEEPS_HOME/releases` (default `~/.agent-beeps/releases`), never plugin-cache
version ordering, PATH or the npm global link. It admits at most 64 candidates,
checking a 15-second discovery budget between filesystem operations; synchronous
fingerprinting may exceed that budget before it returns. Each probe is limited to
five seconds or the positive remaining budget. Use an explicit source when
discovery is too broad. Incomplete/unknown toolchains and unsupported lock schemes
refuse. Config, lock and selected runtime are rechecked before dispatch; this does
not provide a transaction against concurrent project edits during the check.

`E_RUNTIME_MISSING` names the required toolchain and setup action when no usable
candidate is installed. Restore the project's separately declared pin with
`node "<pinned-plugin-root>/scripts/setup.js" --json`, then retry. For isolated
restoration set both `AGENT_BEEPS_HOME` and `npm_config_prefix` to disposable paths;
old setup scripts link globally within the configured prefix. Keep the same home
for the check. No setup, download or global relink happens automatically.
`E_TOOLCHAIN` indicates ambiguity or an incompatible explicit pin; `E_LOCK`
indicates an unsupported/incomplete lock. Selection failures are separate from
the selected checker's stale-recipe and missing/corrupt-output reports. Do not
rerender or rebaseline delivered assets to clear a selection failure.
