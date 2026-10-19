import { basename, join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { readSampleWav } from '../../runtime/engine/sample-wav.js';
import { decodeAudio, type DecoderIdentity } from '../audio/decode.ts';
import { writeWav } from '../audio/wav.ts';
import { BeepsError } from '../errors.ts';
import { canonicalJson, sha256 } from '../hash.ts';
import { PREPARED_MAX_FRAMES, readSampleObject, SAMPLE_ID_PATTERN, sampleId, samplePaths, SOURCE_MAX_FRAMES, verifyImmutableFile, writeImmutableFile, type SampleId } from './store.ts';

// All controls are required: zero fades and zero gain must be explicit in durable recipes.
export const SamplePrepSchema = z.strictObject({
  schema: z.literal('beeps/sample-prep@1'), source: z.string().regex(SAMPLE_ID_PATTERN),
  startFrame: z.number().int().nonnegative().max(SOURCE_MAX_FRAMES - 1), endFrame: z.number().int().positive().max(SOURCE_MAX_FRAMES),
  fadeInFrames: z.number().int().nonnegative().max(PREPARED_MAX_FRAMES), fadeOutFrames: z.number().int().nonnegative().max(PREPARED_MAX_FRAMES),
  gainDb: z.number().min(-60).max(24),
}).superRefine((r, ctx) => {
  const frames = r.endFrame - r.startFrame;
  if (frames < 1 || frames > PREPARED_MAX_FRAMES) ctx.addIssue({ code: 'custom', path: ['endFrame'], message: 'crop must contain 1..480000 frames, end-exclusive' });
  if (r.fadeInFrames + r.fadeOutFrames > frames) ctx.addIssue({ code: 'custom', path: ['fadeOutFrames'], message: 'fade lengths must not overlap or exceed the crop' });
});
export type SamplePrep = z.infer<typeof SamplePrepSchema>;

export function parseSamplePrep(input: unknown): SamplePrep {
  const r = SamplePrepSchema.safeParse(input);
  if (!r.success) throw new BeepsError('E_SCHEMA', `invalid sample preparation: ${r.error.issues[0].message}`, { pointer: `/${r.error.issues[0].path.join('/')}` });
  return r.data;
}

type ProjectLocation = Parameters<typeof samplePaths>[0];
interface AudioMetadata { sampleRate: 48000; channels: 1 | 2; frames: number; bytes: number }
export interface SampleImportReceipt {
  schema: 'beeps/sample-import@1'; originalId: SampleId; originalName: string; normalizedId: SampleId;
  decoder: DecoderIdentity; sourceSampleRate: number; originalPath: string; importedAt: string; origin?: string; license?: string;
}
export interface ImportedSample extends AudioMetadata {
  receiptId: SampleId; originalId: SampleId; normalizedId: SampleId;
  originalPath: string; objectPath: string; receiptPath: string; receipt: SampleImportReceipt;
}

function commitFiles(files: { path: string; bytes: Buffer }[]): void {
  for (const f of files) verifyImmutableFile(f.path, f.bytes);
  for (const f of files) writeImmutableFile(f.path, f.bytes);
}
const jsonBytes = (data: unknown) => Buffer.from(canonicalJson(data) + '\n');
const MAX_ORIGINAL_BYTES = 64 * 1024 * 1024;

export function importSample(project: ProjectLocation, file: string, options: { origin?: string; license?: string } = {}): ImportedSample {
  for (const [key, value] of Object.entries(options)) if (!['origin', 'license'].includes(key) || typeof value !== 'string' || !value.trim()) throw new BeepsError('E_SCHEMA', `sample import ${key} must be a nonempty string`);
  let original: Buffer;
  try {
    if (statSync(file).size > MAX_ORIGINAL_BYTES) throw new BeepsError('E_SCHEMA', 'sample original exceeds 64 MiB');
    original = readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new BeepsError('E_NOT_FOUND', `sample original not found: ${file}`);
    throw e;
  }
  if (original.length > MAX_ORIGINAL_BYTES) throw new BeepsError('E_SCHEMA', 'sample original exceeds 64 MiB');
  // Decode a temporary copy of the exact retained bytes, avoiding a second read of a mutable source file.
  const temporary = mkdtempSync(join(tmpdir(), 'beeps-import-'));
  let decoded;
  try {
    const snapshot = join(temporary, basename(file)); writeFileSync(snapshot, original);
    decoded = decodeAudio(snapshot, { rate: 48000, maxSeconds: 120, maxFrames: SOURCE_MAX_FRAMES, maxChannels: 2, maxInputBytes: MAX_ORIGINAL_BYTES, identity: true });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const wav = writeWav(decoded.channels, 48000, { bits: 32 });
  let pcm;
  try { pcm = readSampleWav(wav, { maxFrames: SOURCE_MAX_FRAMES }); }
  catch (e) { throw new BeepsError('E_SCHEMA', `invalid imported sample: ${(e as Error).message}`); }
  const paths = samplePaths(project), originalId = sampleId(original), normalizedId = sampleId(wav);
  const receipt: SampleImportReceipt = {
    schema: 'beeps/sample-import@1', originalId, originalName: basename(file), normalizedId, decoder: decoded.decoder!,
    sourceSampleRate: decoded.sourceRate, originalPath: resolve(file), importedAt: new Date().toISOString(),
    ...(options.origin !== undefined ? { origin: options.origin } : {}), ...(options.license !== undefined ? { license: options.license } : {}),
  };
  const receiptId: SampleId = `sha256:${sha256(canonicalJson(receipt))}`;
  const originalPath = join(paths.originals, `${originalId.slice(7)}.bin`), objectPath = join(paths.objects, `${normalizedId.slice(7)}.wav`), receiptPath = join(paths.imports, `${receiptId.slice(7)}.json`);
  commitFiles([{ path: originalPath, bytes: original }, { path: objectPath, bytes: wav }, { path: receiptPath, bytes: jsonBytes(receipt) }]);
  return { receiptId, originalId, normalizedId, originalPath, objectPath, receiptPath, receipt, sampleRate: 48000, channels: pcm.channels.length as 1 | 2, frames: pcm.frames, bytes: wav.length };
}

export interface SamplePreparedReceipt extends AudioMetadata {
  schema: 'beeps/sample-prepared@1'; recipeId: SampleId; recipe: SamplePrep; outputId: SampleId;
}
export interface PreparedSample extends AudioMetadata { recipeId: SampleId; outputId: SampleId; objectPath: string; recipePath: string; receipt: SamplePreparedReceipt }

const PreparedReceiptSchema = z.strictObject({
  schema: z.literal('beeps/sample-prepared@1'), recipeId: z.string().regex(SAMPLE_ID_PATTERN), recipe: SamplePrepSchema,
  outputId: z.string().regex(SAMPLE_ID_PATTERN), sampleRate: z.literal(48000), channels: z.union([z.literal(1), z.literal(2)]),
  frames: z.number().int().min(1).max(PREPARED_MAX_FRAMES), bytes: z.number().int().min(48).max(44 + PREPARED_MAX_FRAMES * 8),
});

export function parseSamplePreparedReceipt(input: unknown): SamplePreparedReceipt {
  const r = PreparedReceiptSchema.safeParse(input);
  if (!r.success) throw new BeepsError('E_SCHEMA', `invalid sample preparation receipt: ${r.error.issues[0].message}`, { pointer: `/${r.error.issues[0].path.join('/')}` });
  if (r.data.recipeId !== `sha256:${sha256(canonicalJson(r.data.recipe))}`) throw new BeepsError('E_VERIFY', 'sample preparation recipe ID mismatch');
  if (r.data.frames !== r.data.recipe.endFrame - r.data.recipe.startFrame || r.data.bytes !== 44 + r.data.frames * r.data.channels * 4) throw new BeepsError('E_VERIFY', 'sample preparation receipt metadata mismatch');
  return r.data as SamplePreparedReceipt;
}

/** Pure replay used by preparation and portable-bundle preflight; publishes no files. */
export function prepareSampleWav(input: unknown, sourceWav: Buffer): { wav: Buffer; receipt: SamplePreparedReceipt } {
  const expected = (input as { schema?: unknown } | null)?.schema === 'beeps/sample-prepared@1' ? parseSamplePreparedReceipt(input) : undefined;
  const recipe = expected?.recipe ?? parseSamplePrep(input);
  if (sampleId(sourceWav) !== recipe.source) throw new BeepsError('E_VERIFY', 'sample preparation source hash mismatch');
  let pcm;
  try { pcm = readSampleWav(sourceWav, { maxFrames: SOURCE_MAX_FRAMES }); }
  catch (e) { throw new BeepsError('E_SCHEMA', `invalid preparation source WAV: ${(e as Error).message}`); }
  if (recipe.endFrame > pcm.frames) throw new BeepsError('E_SCHEMA', `sample crop end exceeds source length ${pcm.frames}`, { pointer: '/endFrame' });
  const frames = recipe.endFrame - recipe.startFrame, gain = 10 ** (recipe.gainDb / 20);
  const channels = pcm.channels.map(channel => {
    const out = channel.slice(recipe.startFrame, recipe.endFrame);
    for (let i = 0; i < frames; i++) {
      let scale = 1;
      if (i < recipe.fadeInFrames) scale = recipe.fadeInFrames === 1 ? 0 : i / (recipe.fadeInFrames - 1);
      if (i >= frames - recipe.fadeOutFrames) scale = recipe.fadeOutFrames === 1 ? 0 : (frames - 1 - i) / (recipe.fadeOutFrames - 1);
      // Crop -> amplitude fade -> gain in double precision; quantize once at the Float32 write.
      out[i] = (out[i] * scale) * gain;
      if (!Number.isFinite(out[i])) throw new BeepsError('E_SCHEMA', 'prepared sample PCM overflows Float32; reduce gain');
    }
    return out;
  });
  const wav = writeWav(channels, 48000, { bits: 32 }), outputId = sampleId(wav), recipeId: SampleId = `sha256:${sha256(canonicalJson(recipe))}`;
  const metadata = { sampleRate: 48000 as const, channels: channels.length as 1 | 2, frames, bytes: wav.length };
  const receipt: SamplePreparedReceipt = { schema: 'beeps/sample-prepared@1', recipeId, recipe, outputId, ...metadata };
  if (expected && canonicalJson(expected) !== canonicalJson(receipt)) throw new BeepsError('E_VERIFY', 'sample preparation output or metadata differs from receipt');
  return { wav, receipt };
}

export function prepareSample(project: ProjectLocation, input: unknown): PreparedSample {
  const recipe = (input as { schema?: unknown } | null)?.schema === 'beeps/sample-prepared@1' ? parseSamplePreparedReceipt(input).recipe : parseSamplePrep(input);
  const paths = samplePaths(project), source = readSampleObject(paths.objects, recipe.source, { maxFrames: SOURCE_MAX_FRAMES });
  const { wav, receipt } = prepareSampleWav(input, source.wav), { recipeId, outputId, sampleRate, channels, frames, bytes } = receipt;
  const metadata = { sampleRate, channels, frames, bytes };
  const objectPath = join(paths.objects, `${outputId.slice(7)}.wav`), recipePath = join(paths.recipes, `${recipeId.slice(7)}.json`);
  commitFiles([{ path: objectPath, bytes: wav }, { path: recipePath, bytes: jsonBytes(receipt) }]);
  return { recipeId, outputId, objectPath, recipePath, receipt, ...metadata };
}
