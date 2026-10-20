import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readSampleWav } from '../../runtime/engine/sample-wav.js';
import { decodeAudio } from '../audio/decode.ts';
import { writeWav } from '../audio/wav.ts';
import { BeepsError } from '../errors.ts';
import { canonicalJson, sha256 } from '../hash.ts';
import { openProject, type OpenProject } from '../project.ts';
import { openRenderHost } from '../render/host.ts';
import { overviewAudio, overviewLook, sec, SR } from './overview.ts';
import { MAX_ORIGINAL_BYTES } from './prepare.ts';
import { assertSampleId, readSampleObject, sampleId, samplePaths, SOURCE_MAX_FRAMES, type SampleId } from './store.ts';

export interface OverviewRequest {
  source: string; projectDir: string; gapDb: number; minGapMs: number; image: boolean;
  startSec?: number; endSec?: number; out?: string;
}

interface Loaded { channels: Float32Array[]; normalizedId: SampleId; file?: string }

function load(req: OverviewRequest, project: OpenProject | undefined): Loaded {
  if (req.source.startsWith('sha256:')) {
    const object = readSampleObject(samplePaths(project!).objects, req.source, { maxFrames: SOURCE_MAX_FRAMES });
    return { channels: readSampleWav(object.wav, { maxFrames: SOURCE_MAX_FRAMES }).channels, normalizedId: object.id };
  }
  // The same decode `sample import` makes, so the normalized ID is the one import will report.
  const decoded = decodeAudio(resolve(req.source), { rate: 48000, maxSeconds: 120, maxFrames: SOURCE_MAX_FRAMES, maxChannels: 2, maxInputBytes: MAX_ORIGINAL_BYTES });
  return { channels: decoded.channels, normalizedId: sampleId(writeWav(decoded.channels, 48000, { bits: 32 })), file: basename(req.source) };
}

export async function runOverview(req: OverviewRequest) {
  if (!(req.gapDb > 0 && req.gapDb <= 100)) throw new BeepsError('E_SCHEMA', '--gap-db must be above 0 and at most 100');
  if (!(req.minGapMs >= 10 && req.minGapMs <= 10000)) throw new BeepsError('E_SCHEMA', '--min-gap must be 10 to 10000 ms');
  if (req.startSec !== undefined && req.startSec < 0) throw new BeepsError('E_SCHEMA', '--start must not be negative');
  if (req.endSec !== undefined && req.endSec <= (req.startSec ?? 0)) throw new BeepsError('E_SCHEMA', '--end must be after --start');
  const byId = req.source.startsWith('sha256:');
  if (byId) assertSampleId(req.source);
  let project: OpenProject | undefined;
  try { project = openProject(req.projectDir); }
  catch (e) { if (byId || !(e instanceof BeepsError) || e.code !== 'E_PROJECT') throw e; }
  if (req.image && !req.out && !project) throw new BeepsError('E_USAGE', 'outside a project the image needs --out <png> (or pass --no-image)');

  const loaded = load(req, project), total = loaded.channels[0].length;
  const startFrame = req.startSec === undefined ? 0 : Math.round(req.startSec * SR);
  const endFrame = req.endSec === undefined ? total : Math.round(req.endSec * SR);
  if (startFrame >= total) throw new BeepsError('E_SCHEMA', `--start is beyond the source length ${sec(total)} s`, { pointer: '/startFrame' });
  if (endFrame > total) throw new BeepsError('E_SCHEMA', `--end is beyond the source length ${sec(total)} s`, { pointer: '/endFrame' });

  const o = overviewAudio(loaded.channels, { gapDb: req.gapDb, minGapMs: req.minGapMs, startFrame, endFrame });
  const hints = [...o.hints];
  if (loaded.file !== undefined) hints.push(`the prepare lines use ${loaded.normalizedId}, the ID import will give this file: run beeps sample import ${JSON.stringify(req.source)} first and check the IDs match`);

  let image: string | null = null;
  if (req.image) {
    const key = sha256(canonicalJson({ id: loaded.normalizedId, startFrame, endFrame, gapDb: req.gapDb, minGapMs: req.minGapMs })).slice(0, 12);
    image = req.out ? resolve(req.out) : join(project!.paths.renders, 'overviews', `${key}.png`);
    const label = loaded.file ?? `${loaded.normalizedId.slice(0, 15)}...`;
    const host = await openRenderHost();
    let png: Buffer;
    try { png = await host.songPcmLook(loaded.channels.map(c => c.subarray(startFrame, endFrame)), overviewLook(o), label); } finally { await host.close(); }
    mkdirSync(dirname(image), { recursive: true });
    writeFileSync(image, png);
  }
  return {
    source: { ...(loaded.file !== undefined ? { file: loaded.file } : {}), normalizedId: loaded.normalizedId, durationSec: sec(total), sampleRate: 48000, channels: loaded.channels.length, view: { startSec: o.view.startSec, endSec: o.view.endSec } },
    image,
    segments: o.segments.map(s => ({ ...s, prepare: `beeps sample prepare ${loaded.normalizedId} --start ${s.startSec} --end ${s.endSec}` })),
    omitted: o.omitted,
    hints,
  };
}
