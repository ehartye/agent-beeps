import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readSampleWav } from '../../runtime/engine/sample-wav.js';
import { decodeAudio } from '../audio/decode.ts';
import { BeepsError } from '../errors.ts';
import { canonicalJson, sha256 } from '../hash.ts';
import { findProjectRoot, openProject, type OpenProject } from '../project.ts';
import { openRenderHost, type RenderHost } from '../render/host.ts';
import { overviewAudio, overviewLook, sec, SR, type Overview } from './overview.ts';
import { normalizedSampleWav, SAMPLE_DECODE_LIMITS } from './prepare.ts';
import { assertSampleId, readSampleObject, sampleId, samplePaths, SOURCE_MAX_FRAMES, type SampleId } from './store.ts';

export interface OverviewRequest {
  source: string; projectDir: string; gapDb: number; minGapMs: number; image: boolean;
  startSec?: number; endSec?: number; out?: string;
}

interface Loaded { channels: Float32Array[]; normalizedId: SampleId; file?: string }

function loadId(id: SampleId, project: OpenProject): Loaded {
  const object = readSampleObject(samplePaths(project).objects, id, { maxFrames: SOURCE_MAX_FRAMES });
  return { channels: readSampleWav(object.wav, { maxFrames: SOURCE_MAX_FRAMES }).channels, normalizedId: object.id };
}

// The same decode and encoding `sample import` uses, so the normalized ID is the one import will report.
function loadFile(path: string): Loaded {
  const decoded = decodeAudio(resolve(path), SAMPLE_DECODE_LIMITS);
  return { channels: decoded.channels, normalizedId: sampleId(normalizedSampleWav(decoded.channels)), file: basename(path) };
}

/** Render the overview image and write it; the directory is made only once there is a PNG to put in it. */
async function drawOverview(openHost: () => Promise<RenderHost>, req: OverviewRequest, project: OpenProject | undefined, loaded: Loaded, o: Overview): Promise<string> {
  const { startFrame, endFrame } = o.view;
  const key = sha256(canonicalJson({ id: loaded.normalizedId, startFrame, endFrame, gapDb: req.gapDb, minGapMs: req.minGapMs })).slice(0, 12);
  const image = req.out ? resolve(req.out) : project ? join(project.paths.renders, 'overviews', `${key}.png`) : undefined;
  if (!image) throw new BeepsError('E_USAGE', 'outside a project the image needs --out <png> (or pass --no-image)');
  const label = loaded.file ?? `${loaded.normalizedId.slice(0, 15)}...`;
  const host = await openHost();
  let png: Buffer;
  try { png = await host.songPcmLook(loaded.channels.map(c => c.subarray(startFrame, endFrame)), overviewLook(o), label); } finally { await host.close(); }
  mkdirSync(dirname(image), { recursive: true });
  writeFileSync(image, png);
  return image;
}

export async function runOverview(req: OverviewRequest, openHost: () => Promise<RenderHost> = openRenderHost) {
  if (!(req.gapDb > 0 && req.gapDb <= 100)) throw new BeepsError('E_SCHEMA', '--gap-db must be above 0 and at most 100');
  if (!(req.minGapMs >= 10 && req.minGapMs <= 10000)) throw new BeepsError('E_SCHEMA', '--min-gap must be 10 to 10000 ms');
  if (req.startSec !== undefined && req.startSec < 0) throw new BeepsError('E_SCHEMA', '--start must not be negative');
  if (req.endSec !== undefined && req.endSec <= (req.startSec ?? 0)) throw new BeepsError('E_SCHEMA', '--end must be after --start');
  if (!req.image && req.out) throw new BeepsError('E_USAGE', '--out needs an image: drop --no-image');
  const byId = req.source.startsWith('sha256:');
  if (byId) assertSampleId(req.source);
  // A project is optional only for a file; a corrupt one is an error either way, never "no project".
  const root = findProjectRoot(req.projectDir), project = root ? openProject(root) : undefined;
  if (byId && !project) throw new BeepsError('E_PROJECT', 'a sample ID needs a project', { hint: 'run "beeps init" in the project root, or pass an audio file' });
  if (req.image && !req.out && !project) throw new BeepsError('E_USAGE', 'outside a project the image needs --out <png> (or pass --no-image)');

  const loaded = project && byId ? loadId(req.source as SampleId, project) : loadFile(req.source), total = loaded.channels[0].length;
  const startFrame = req.startSec === undefined ? 0 : Math.round(req.startSec * SR);
  const endFrame = req.endSec === undefined ? total : Math.round(req.endSec * SR);
  if (startFrame >= total) throw new BeepsError('E_SCHEMA', `--start is beyond the source length ${sec(total)} s`, { pointer: '/startFrame' });
  if (endFrame > total) throw new BeepsError('E_SCHEMA', `--end is beyond the source length ${sec(total)} s`, { pointer: '/endFrame' });

  const o = overviewAudio(loaded.channels, { gapDb: req.gapDb, minGapMs: req.minGapMs, startFrame, endFrame });
  const hints = [...o.hints];
  if (loaded.file !== undefined) hints.push(`the prepare lines use ${loaded.normalizedId}: run beeps sample import "${resolve(req.source)}" and check that the normalizedId it prints equals the one used in these prepare lines`);
  const image = req.image ? await drawOverview(openHost, req, project, loaded, o) : null;
  return {
    source: { ...(loaded.file !== undefined ? { file: loaded.file } : {}), normalizedId: loaded.normalizedId, durationSec: sec(total), sampleRate: 48000, channels: loaded.channels.length, view: { startSec: o.view.startSec, endSec: o.view.endSec } },
    image,
    segments: o.segments.map(s => ({ ...s, prepare: `beeps sample prepare ${loaded.normalizedId} --start ${s.startSec} --end ${s.endSec}` })),
    omitted: o.omitted,
    hints,
  };
}
