import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { analyzeAudio, type Analysis } from '../analyze.ts';
import { compareAnalyses } from '../compare.ts';

/** The numbers a person reads first when two sounds are side by side. */
const headline = (a: Analysis) => ({
  durationSec: a.durationSec, events: a.events.count, rpm: a.events.rpm, intervalCv: a.events.intervalCv, floorDb: a.events.floorDb,
  crestDb: a.features.crestDb, centroidHz: a.features.centroidHz, integratedLufs: a.features.integratedLufs, clippedSamples: a.features.clippedSamples,
});

export function registerAnalyzeCommands(program: Command, io: Io) {
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
