// beeps kit golden bless | check: the blessed render of each kit sound and the check against it (src/golden.ts).
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { BeepsError } from '../errors.ts';
import { goldenOf, judgeGolden, readGolden, sha256Bytes, writeGolden, type Golden, type GoldenResult } from '../golden.ts';
import { readKit } from '../kit.ts';
import { loadPatch, openProject } from '../project.ts';
import { renderOptions } from '../render/options.ts';
import { renderAndMeasure } from '../render/pipeline.ts';
import { withHost } from './shared.ts';

export function registerGoldenCommands(kit: Command, io: Io) {
  const golden = kit.command('golden').description('a blessed render of each kit sound, and a check that says whether today\'s render is identical, equivalent within tolerances, or different');

  /** The kit sounds a command was asked about (all of them when none are named), each with the seed to render at. */
  const selection = (names: string[], seedOf: (name: string, kitSeed: number | undefined) => number) => {
    const p = openProject(io.projectDir());
    const k = readKit(p.paths.root);
    const chosen = names.length ? names.map(n => k.sounds.find(s => s.name === n) ?? (() => { throw new BeepsError('E_NOT_FOUND', `no kit sound "${n}"`, { hint: `kit sounds: ${k.sounds.map(s => s.name).join(', ') || 'none; add some with beeps kit add'}`, received: n }); })()) : k.sounds;
    if (!chosen.length) throw new BeepsError('E_USAGE', 'the kit has no sounds', { hint: 'add sounds with beeps kit add first' });
    return { p, items: chosen.map(s => ({ name: s.name, seed: seedOf(s.name, s.seed), patch: loadPatch(p, s.name) })) };
  };

  golden.command('bless [names...]')
    .description('render kit sounds (all of them, or the ones named) at their kit seed and store each as the blessed copy in .agent-beeps/golden/, replacing an earlier blessing but keeping its tolerance overrides')
    .action(async (names: string[]) => {
      const { p, items } = selection(names, (_n, s) => s ?? 1);
      const out = await withHost(host => renderAndMeasure(host, items.map(i => ({ patch: i.patch, seed: i.seed })), renderOptions(p)));
      const failed = out.flatMap((o, i) => (o.ok ? [] : [{ name: items[i].name, ok: false as const, error: o.error }]));
      const blessed = out.flatMap((o, i) => {
        if (!o.ok) return [];
        const g = goldenOf(items[i].name, items[i].seed, o.key, readFileSync(o.wavPath), o.features, readGolden(p.paths.dir, items[i].name));
        return [{ name: g.name, seed: g.seed, wavSha256: g.wavSha256.slice(0, 12), file: writeGolden(p.paths.dir, g) }];
      });
      io.emit({ blessed, ...(failed.length ? { failed } : {}) });
      if (failed.length) process.exitCode = 1;
    });

  golden.command('check [names...]')
    .description('render kit sounds at their blessed seed and say, for each, identical (the same samples), equivalent (different samples, every measure inside its tolerance) or different (with what moved); exits 1 on different, on a sound with no blessed copy, or on one that will not render')
    .action(async (names: string[]) => {
      const p0 = openProject(io.projectDir());
      const blessed = new Map<string, Golden | undefined>();
      const { p, items } = selection(names, (n, s) => { const g = readGolden(p0.paths.dir, n); blessed.set(n, g); return g?.seed ?? s ?? 1; });
      const todo = items.filter(i => blessed.get(i.name));
      const out = todo.length ? await withHost(host => renderAndMeasure(host, todo.map(i => ({ patch: i.patch, seed: i.seed })), renderOptions(p))) : [];
      const results = items.map(i => {
        const g = blessed.get(i.name);
        if (!g) return { name: i.name, verdict: 'unblessed' as const, hint: `beeps kit golden bless ${i.name}` };
        const o = out[todo.indexOf(i)];
        if (!o.ok) return { name: i.name, verdict: 'error' as const, error: o.error };
        const r: GoldenResult = judgeGolden(g, { wavSha256: sha256Bytes(readFileSync(o.wavPath)), features: o.features });
        return { name: i.name, seed: g.seed, ...r, ...(o.key !== g.key ? { keyChanged: true } : {}) };
      });
      const count = (v: string) => results.filter(r => r.verdict === v).length;
      io.emit({ results, summary: { identical: count('identical'), equivalent: count('equivalent'), different: count('different'), unblessed: count('unblessed'), error: count('error') } });
      if (results.some(r => r.verdict === 'different' || r.verdict === 'unblessed' || r.verdict === 'error')) process.exitCode = 1;
    });
}
