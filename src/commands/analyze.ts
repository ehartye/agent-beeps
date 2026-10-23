import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { analyzeAudio, type Analysis } from '../analyze.ts';
import { compareAnalyses } from '../compare.ts';
import { decodeAudio } from '../audio/decode.ts';
import { mixToMono } from '../audio/mono.ts';
import { spectrogramDiff } from '../diff/spectrogram-diff.ts';
import { BeepsError } from '../errors.ts';
import { createHash } from 'node:crypto';
import { sha256 } from '../hash.ts';
import { kitSeed, readKit } from '../kit.ts';
import { requireSafeOutput } from '../path-safety.ts';
import { findProjectRoot, loadPatch, openProject, type OpenProject } from '../project.ts';
import { renderAndMeasure } from '../render/pipeline.ts';
import { renderOptions } from '../render/options.ts';
import { int, withHost } from './shared.ts';

/** An existing audio file is used as it is; anything else is a patch (name, set candidate or .json path) rendered at its kit seed. */
const readFileBytes = (path: string) => readFileSync(path);
const isAudioFile = (ref: string) => /.(wav|mp3|ogg|flac|opus|m4a)$/i.test(ref) && existsSync(ref);

/** The numbers a person reads first when two sounds are side by side. */
const headline = (a: Analysis) => ({
  durationSec: a.durationSec, events: a.events.count, rpm: a.events.rpm, intervalCv: a.events.intervalCv, floorDb: a.events.floorDb,
  crestDb: a.features.crestDb, centroidHz: a.features.centroidHz, integratedLufs: a.features.integratedLufs, clippedSamples: a.features.clippedSamples,
});

export function registerAnalyzeCommands(program: Command, io: Io) {
  program.command('diff <a> <b>')
    .description('where, and by how many dB, sound b has more or less energy than sound a: a signed spectrogram difference as numbers per band and per third of the sound, the feature deltas and hints, and a blue-white-red image (red: b has more). a and b are patches (name, set candidate or .json path, rendered at the kit seed) or audio files; use it between refine rounds and before and after a change')
    .option('--out <png>', 'where to write the image (default .agent-beeps/renders/diffs/<key>.png; required outside a project)')
    .option('--seed <n>', 'render seed for patches (default: the seed recorded in the kit, else 1)', int)
    .action(async (a: string, b: string, opts: { out?: string; seed?: number }) => {
      const root = findProjectRoot(io.projectDir());
      const project: OpenProject | undefined = root ? openProject(root) : undefined;
      const needsProject = [a, b].some(r => !isAudioFile(r));
      if (needsProject && !project) throw new BeepsError('E_PROJECT', 'a patch needs a project', { hint: 'run "beeps init" in the project root, or pass two audio files' });
      if (!opts.out && !project) throw new BeepsError('E_USAGE', 'outside a project the image needs --out <png>');
      const files: string[] = [];
      const patches = [a, b].map(ref => (isAudioFile(ref) ? undefined : loadPatch(project!, ref)));
      const rendered = patches.some(Boolean)
        ? await withHost(host => renderAndMeasure(host, patches.flatMap(p => (p ? [{ patch: p, seed: opts.seed ?? kitSeed(readKit(project!.paths.root), p.name) }] : [])), renderOptions(project!)))
        : [];
      let next = 0;
      const labels = [a, b].map((ref, i) => {
        const p = patches[i];
        if (!p) { files.push(resolve(ref)); return ref; }
        const o = rendered[next++];
        if (!o.ok) throw new BeepsError('E_RENDER', `${o.patchName}: ${o.error}`);
        files.push(o.wavPath);
        return `${p.name} (seed ${o.seed})`;
      });
      const [wa, wb] = files.map(f => decodeAudio(f, { rate: 48000 }));
      const d = spectrogramDiff(mixToMono(wa.channels), mixToMono(wb.channels), wa.sampleRate);
      const key = sha256(files.map(f => f + ':' + createHash('sha256').update(readFileBytes(f)).digest('hex')).join('|')).slice(0, 12);
      const image = opts.out ? resolve(opts.out) : join(project!.paths.renders, 'diffs', `${key}.png`);
      requireSafeOutput(image, { ext: '.png', inputs: [a, b].filter(isAudioFile).map(r => resolve(r)) }, '--out');
      mkdirSync(dirname(image), { recursive: true });
      writeFileSync(image, d.png);
      const { png: _png, ...numbers } = d;
      const cmp = compareAnalyses(analyzeAudio(files[0]), analyzeAudio(files[1]));
      io.emit({ a: labels[0], b: labels[1], image, legend: 'blue: b has less energy than a, white: the same, red: b has more; frequency 40 Hz to 20 kHz up the side, time to the right, plus or minus 24 dB at the ends', ...numbers, deltas: cmp.deltas, hints: [...numbers.hints, ...cmp.hints] });
    });

  program.command('analyze <files...>')
    .description('measure audio files beeps did not render (WAV directly; MP3, Ogg, FLAC... through ffmpeg): the patch features plus where the sound is, whether and how it repeats (onsets, rate, regularity, level between events, per-band decay of the mean event) and its spectrum shape. Needs no project')
    .action((files: string[]) => {
      io.emit({ analyses: files.map(f => analyzeAudio(resolve(f))) });
    });

  program.command('compare <reference> <candidate>')
    .description('a candidate audio file against a reference: signed deltas (candidate minus reference) and hints on what to change. Export a patch or song first (beeps export / beeps song export), then compare the WAV')
    .option('--full', 'also print both analyses')
    .action((reference: string, candidate: string, opts: { full?: boolean }) => {
      const ref = analyzeAudio(resolve(reference)), cand = analyzeAudio(resolve(candidate));
      io.emit({
        ...compareAnalyses(ref, cand),
        summary: { reference: headline(ref), candidate: headline(cand) },
        ...(opts.full ? { analyses: { reference: ref, candidate: cand } } : {}),
      });
    });
}
