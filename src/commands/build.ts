// beeps build / verify / store / ci: incremental audio builds with a committed lock and a content-addressed store.
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { BeepsError } from '../errors.ts';
import { loadConfig } from '../build/config.ts';
import { runBuild } from '../build/build.ts';
import { openStore } from '../build/store.ts';
import { ciExport, storePull, storePush, storeStatus } from '../build/store-ops.ts';
import { verifyOutputs } from '../build/verify.ts';
import { int } from './shared.ts';

const list = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean);

export function registerBuildCommands(program: Command, io: Io) {
  const cfgFor = (o: { config?: string }) => loadConfig(io.projectDir(), o.config);
  const storeFor = (cfgStore: string | undefined, flag: string | undefined, base: string) => {
    const spec = flag ?? cfgStore ?? process.env.BEEPS_AUDIO_STORE;
    return spec ? openStore(spec, { base }) : undefined;
  };

  program.command('build')
    .description('render, export, compress and bundle only the assets whose input hash differs from the lock (or whose outputs are missing or modified); writes the lock and index.json')
    .option('--config <file>', 'build config (default: <project>/beeps.build.json)')
    .option('--target <preset>', 'delivery preset: web-universal (Ogg Opus, per-role kbps; default), web-mp3, wav-master')
    .option('--only <ids>', 'comma-separated recipe ids; the rest of the lock and outputs are kept', list)
    .option('--all', 'treat every asset as stale: re-export and re-encode (renders still come from the render cache)')
    .option('--check', 'render nothing and write nothing: exit 1 listing every stale asset, why, and any lock or catalog drift')
    .option('--pull', 'fetch stale assets by input hash from the store before rendering anything')
    .option('--push', 'publish the assets this run built to the store')
    .option('--store <spec>', 'dir:<path> or release:<owner/repo>[@tag] (default: the config\'s, then $BEEPS_AUDIO_STORE)')
    .option('--adopt', 'take over a lock written by another tool, or by an older toolchain: verify its output hashes and re-key it, with no rendering (keeps the locked files)')
    .option('--allow-toolchain-change', 'rebuild even though the engine, pipeline, Chromium or ffmpeg differs from the lock (re-renders what the store lacks)')
    .option('--verify-determinism', 'render every song twice and fail the asset (E_NONDETERMINISTIC) when the two renders differ in any sample; doubles song render time')
    .option('--jobs <n>', 'parallel render hosts (default: the config\'s, 3)', int)
    .action(async (o: { config?: string; target?: string; only?: string[]; all?: boolean; check?: boolean; pull?: boolean; push?: boolean; store?: string; adopt?: boolean; allowToolchainChange?: boolean; verifyDeterminism?: boolean; jobs?: number }) => {
      const cfg = cfgFor(o);
      if (o.target) cfg.target = o.target;
      const store = storeFor(cfg.store, o.store, cfg.dir);
      if ((o.pull || o.push) && !store) throw new BeepsError('E_USAGE', '--pull and --push need a store', { hint: '--store dir:<path> | release:<owner/repo>, or "store" in beeps.build.json' });
      const report = await runBuild(cfg, { only: o.only, all: o.all, check: o.check, pull: o.pull, push: o.push, store, adopt: o.adopt, allowToolchainChange: o.allowToolchainChange, verifyDeterminism: o.verifyDeterminism, jobs: o.jobs, log: s => console.error(s) });
      io.emit(report);
      if (!report.ok) process.exitCode = 1;
    });

  program.command('verify [target]')
    .description('check outputs against the lock (sha256, size), the catalog, and container headers (Opus granule length, MP3 Xing tag and encoder id); target: the output directory or a lock file (default: the build config)')
    .option('--config <file>', 'build config (default: <project>/beeps.build.json)')
    .option('--lock <file>', 'the lock (default: the config\'s, else <dir>/audio.lock.json)')
    .option('--out <dir>', 'the output directory when the target is a lock file')
    .option('--decode', 'also decode loops and check their frame counts and wraps (needs ffmpeg)')
    .action((target: string | undefined, o: { config?: string; lock?: string; out?: string; decode?: boolean }) => {
      let lock = o.lock, out = o.out;
      if (target) {
        if (target.endsWith('.json')) { lock = lock ?? resolve(target); } else { out = out ?? resolve(target); lock = lock ?? resolve(target, 'audio.lock.json'); }
      }
      if (!lock || !out) {
        const cfg = cfgFor(o);
        lock = lock ?? cfg.lock; out = out ?? cfg.out;
      }
      const r = verifyOutputs({ lock, out, decode: o.decode });
      io.emit(r);
      if (!r.ok) process.exitCode = 1;
    });

  const store = program.command('store').description('the content-addressed audio store: one tar per asset, named by input hash, immutable (dir: or release: backends)');
  const storeOpts = (c: Command) => c.option('--config <file>', 'build config (default: <project>/beeps.build.json)').option('--store <spec>', 'dir:<path> or release:<owner/repo>[@tag]').option('--only <ids>', 'comma-separated recipe ids', list);
  storeOpts(store.command('push').description('publish every locked asset whose outputs verify and that the store lacks (first writer wins; entries are never replaced)'))
    .action(async (o: { config?: string; store?: string; only?: string[] }) => {
      const cfg = cfgFor(o), s = storeFor(cfg.store, o.store, cfg.dir);
      if (!s) throw new BeepsError('E_USAGE', 'no store', { hint: '--store dir:<path> | release:<owner/repo>' });
      const r = await storePush(cfg, s, o.only);
      io.emit(r);
      if (!r.ok) process.exitCode = 1;
    });
  storeOpts(store.command('pull').description('write the locked assets from the store into the output directory, verifying every file against the lock'))
    .action(async (o: { config?: string; store?: string; only?: string[] }) => {
      const cfg = cfgFor(o), s = storeFor(cfg.store, o.store, cfg.dir);
      if (!s) throw new BeepsError('E_USAGE', 'no store', { hint: '--store dir:<path> | release:<owner/repo>' });
      const r = await storePull(cfg, s, o.only);
      io.emit(r);
      if (!r.ok) process.exitCode = 1;
    });
  storeOpts(store.command('status').description('per locked asset: are its outputs built here, and is it in the store'))
    .action(async (o: { config?: string; store?: string; only?: string[] }) => {
      const cfg = cfgFor(o);
      io.emit(await storeStatus(cfg, storeFor(cfg.store, o.store, cfg.dir), o.only));
    });

  const ci = program.command('ci').description('continuous integration helpers');
  ci.command('export <dir>')
    .description('write a zero-dependency fetch.mjs into <dir>: `node fetch.mjs` materialises the output directory from the store by hash and verifies sha256, with no beeps, Chromium or ffmpeg')
    .option('--config <file>', 'build config (default: <project>/beeps.build.json)')
    .option('--store <spec>', 'bake this store into the script (default: the config\'s)')
    .action((dir: string, o: { config?: string; store?: string }) => io.emit(ciExport(cfgFor(o), resolve(dir), o.store)));
}
