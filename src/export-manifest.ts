// Portable metadata for the exact delivered WAV: its loudness trim is already in the samples.
import { closeSync, openSync, readSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import { BeepsError } from './errors.ts';
import type { Rendered } from './render/pipeline.ts';
import type { RenderedSong } from './render/song-pipeline.ts';

const Role = z.enum(['sfx', 'music', 'ambience']);
export type ExportRole = z.infer<typeof Role>;
const Variant = z.strictObject({ file: z.string().min(1), weight: z.number().min(0).optional() });
const LayerFile = z.strictObject({ name: z.string().min(1), file: z.string().min(1) });
export const ExportManifestSchema = z.strictObject({
  schema: z.literal('beeps/audio-asset@1'),
  id: z.string().min(1), label: z.string().min(1), description: z.string(),
  role: Role, file: z.string().min(1), loop: z.boolean(),
  durationSec: z.number().positive(), sampleRate: z.number().int().positive(), channels: z.number().int().positive(),
  renderKey: z.string().min(1),
  loudness: z.strictObject({ metric: z.enum(['momentary-max', 'integrated']), lufs: z.number() }),
  truePeakDb: z.number(), normalizationAlreadyApplied: z.literal(true),
  // Optional, additive: sidecars written before these existed stay valid.
  // 1 is most important, 5 least (FMOD convention, as meta.priority and the kit)
  priority: z.number().int().min(1).max(5).optional(),
  variants: z.array(Variant).min(1).optional(),
  noRepeat: z.boolean().optional(),
  bpm: z.number().positive().optional(),
  meter: z.number().int().positive().optional(),
  layers: z.array(LayerFile).min(1).optional(),
  states: z.record(z.string(), z.array(z.string())).optional(),
  initialState: z.string().optional(),
  /** Present when the files were re-encoded after export (`beeps compress`); durationSec and the sample rate still describe the decoded audio. */
  encoding: z.strictObject({ codec: z.literal('opus'), container: z.literal('ogg'), kbps: z.number().positive() }).optional(),
});
export type ExportManifest = z.infer<typeof ExportManifestSchema>;

export function exportRole(role: string | undefined, manifest: boolean | undefined, fallback: ExportRole): ExportRole {
  if (role !== undefined && !manifest) throw new BeepsError('E_USAGE', '--role requires --manifest');
  const r = Role.safeParse(role ?? fallback);
  if (!r.success) throw new BeepsError('E_USAGE', '--role must be sfx, music or ambience');
  return r.data;
}

/** Called after the WAV copy. Internal exports use writeWav's canonical 44-byte PCM header. */
export function writeExportManifest(wav: string, rendered: Rendered | RenderedSong, role: ExportRole, extra: Partial<ExportManifest> = {}, path = `${wav}.json`): string {
  const header = Buffer.alloc(44), fd = openSync(wav, 'r');
  let bytes: number;
  try { bytes = readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  if (bytes !== 44 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE' || header.toString('ascii', 36, 40) !== 'data') {
    throw new BeepsError('E_RENDER', 'export manifest requires a delivered PCM WAV');
  }
  const sampleRate = header.readUInt32LE(24), channels = header.readUInt16LE(22);
  const song = 'song' in rendered ? rendered.song : undefined;
  const id = song?.name ?? (rendered as Rendered).patch.name;
  const name = id.replaceAll('-', ' ');
  const delivered = rendered.features.delivered;
  const manifest = ExportManifestSchema.parse({
    schema: 'beeps/audio-asset@1', id, label: song?.title?.trim() || name.charAt(0).toUpperCase() + name.slice(1),
    description: song ? song.description ?? '' : (rendered as Rendered).patch.meta?.description ?? '',
    role, file: basename(wav), loop: song?.loop ?? false,
    durationSec: header.readUInt32LE(40) / header.readUInt16LE(32) / sampleRate, sampleRate, channels,
    renderKey: rendered.key,
    loudness: 'song' in rendered
      ? { metric: 'integrated', lufs: rendered.features.delivered?.integratedLufs }
      : { metric: 'momentary-max', lufs: rendered.features.delivered.momentaryMaxLufs },
    truePeakDb: delivered?.truePeakDb, normalizationAlreadyApplied: true,
    ...(song ? { bpm: song.bpm, meter: song.meter } : role === 'sfx' ? { priority: (rendered as Rendered).patch.meta?.priority ?? 3 } : {}),
    ...extra,
  });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  return path;
}
