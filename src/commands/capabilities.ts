import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { ERROR_CATEGORIES, ERROR_CODES } from '../errors.ts';
import { NOTICE_CODES, NOTICE_REGISTRY } from '../notices.ts';
import { patchJsonSchema, SOURCE_TYPES } from '../schema/patch.ts';
import { leafCommands } from './inventory.ts';
import { MAX_SAMPLE_FRAMES, SAMPLE_RATE_HZ } from '../../runtime/engine/limits.js';
import { ENGINE_VERSION } from '../../runtime/engine/version.js';
import { SCALES } from '../../runtime/engine/notes.js';
import { REVERB_PRESETS } from '../../runtime/engine/fx.js';
import { FEATURE_NAMES } from '../measure/index.ts';
import { songJsonSchema } from '../schema/song.ts';
import { QUALITIES } from '../../runtime/engine/chords.js';

const EXAMPLE = {
  schema: 'beeps/patch@1', name: 'coin', family: 'coin', tags: ['repeating'], duration: 0.3,
  layers: [{
    source: { type: 'osc', wave: 'square', pitch: 'E6' },
    pitchEnv: [{ at: 0.06, to: 'B6', curve: 'step' }],
    amp: { attack: 0.004, decay: 0.12, sustain: 0, release: 0.05 },
    filter: { type: 'lowpass', cutoff: 6000, resonanceDb: 0 },
  }],
  variation: { pitchCents: 30, variants: 4 },
};

async function archetypeNames(): Promise<string[]> {
  try {
    const mod = await import('../archetypes.ts');
    return mod.loadArchetypes().map((a: { name: string }) => a.name);
  } catch { return []; }
}

export function registerCapabilities(program: Command, io: Io) {
  program.command('capabilities')
    .description('print the patch schema, source types, archetypes, commands and error codes')
    .option('--no-schema', 'omit the full JSON Schema')
    .action(async (opts: { schema: boolean }) => {
      const { VERSION } = await import('../cli.ts');
      const commands = leafCommands(program);
      io.emit({
        version: VERSION,
        engine: ENGINE_VERSION,
        sampleRate: SAMPLE_RATE_HZ,
        commands,
        sourceTypes: SOURCE_TYPES,
        scales: Object.keys(SCALES),
        reverbPresets: Object.keys(REVERB_PRESETS),
        archetypes: await archetypeNames(),
        refineDirections: ['brighter', 'darker', 'punchier', 'softer', 'shorter', 'longer', 'less-harsh', 'more-character'],
        tasteFeatures: FEATURE_NAMES,
        errorCodes: ERROR_CODES,
        errorCategories: ERROR_CATEGORIES,
        noticeCodes: NOTICE_CODES.map(code => ({ code, severity: NOTICE_REGISTRY[code].severity, summary: NOTICE_REGISTRY[code].summary })),
        samples: {
          commands: commands.filter(c => c.name.startsWith('sample ')).map(c => c.name),
          maxLayers: 8,
          prepared: { sampleRate: SAMPLE_RATE_HZ, channels: [1, 2], minFrames: 1, maxFrames: MAX_SAMPLE_FRAMES },
          maxNormalizedSeconds: 120,
          maxOriginalBytes: 64 * 1024 * 1024,
          notes: [
            'Finite, unpitched SFX one-shots: sample pitch envelopes, pitch LFOs, loops, stretching and song sample instruments are unsupported; gain and cutoff LFOs are supported.',
            'Import retains exact originals and local provenance; prepare crops, linearly fades and applies gain to the retained canonical 48 kHz snapshot, with an integer-frame replay recipe.',
            'A recording longer than ten seconds: sample overview <normalizedId|file> [--start --end] images it and lists natural segments of at most ten seconds (peak, loudness, events, flags, a ready prepare line); it proposes, the owner chooses. --no-image skips the browser.',
            'Prepare a named sample patch, edit/add procedural layers, save, render/lint/look, then sample bundle the final edited patch.',
            'Bundles default to prepared dependencies only. --include-preparation adds required normalized source snapshots and replay recipes, possibly including outtakes; neither mode includes original encoded imports, import receipts or private local paths.',
            'render, look, measure, lint, export, runtime and build resolve and verify prepared dependencies before cache reuse; source bundles are restored with sample sync, not ordinary patch sync.',
            'For live cues, resume AudioContext in a user gesture, await loadCueAssets(ctx, cue, {baseURL, signal}), then build(ctx, out, cue, {samples}) with a fresh voice per play. Graph construction stays synchronous and performs no I/O.',
            'Attenuation and the output true-peak ceiling do not repair a source recording that is already clipped.',
          ],
        },
        notes: [
          'Patches never carry a loudness literal: the renderer trims every sound to the project loudness target.',
          'lowpass/highpass take resonanceDb (Chromium treats their Q as dB); bandpass/notch/peaking take q.',
          'Pitched sources snap to the project scale when scale.snap is true.',
          'export is stereo at full render length by default; --channels 1 (identical channels keep their samples) and --trim-tail <dBFS> (e.g. -60, drops a near-silent effect tail) are opt-in.',
          'no-dc: a 45-50 Hz highpass on a low thump, bandpass instead of lowpass on brown/pink noise, or fx.dcBlock: true (opt-in 10 Hz DC blocker; off by default).',
          'render, look and export summaries carry features.peakLimited: the trim stopped at the true-peak ceiling, so the sound sits below its loudness target.',
          'Kit-level rules (family-consistency, masking-risk, key-consistency, one-no, priority-levels) run only in kit check; lint adds a notes line when a linted patch is in the kit or has family members.',
          'A repo that commits its patch files: beeps sync <dir> mirrors them into the project, then lint, kit add and kit check take the names.',
          'Many similar patches: beeps family <template.json> --table rows.csv fills {{param}} placeholders and /pointer columns per row, validates each, and can --lint, --out a folder, or hand off --set; see the beeps-compose family reference.',
          'Hand-made variants authored as separate patches (names <stem>-<n> in one family, or a shared meta.variantOf) count toward variation-on-repeating.',
          'Every render writes a look.png (waveform, spectrogram, features): look at it; you cannot hear.',
          'Errors: a failure that stops a command is one JSON line on stderr (exit 1, or 2 for E_USAGE); items that fail inside a multi-item command appear in the stdout JSON with ok: false. E_INTERNAL is a bug in beeps: rerun with BEEPS_DEBUG=1 for the stack.',
        ],
        example: EXAMPLE,
        music: {
          chordQualities: Object.keys(QUALITIES).filter(Boolean),
          patternKinds: ['notes', 'chords', 'arp', 'bass', 'steps'],
          arpShapes: ['up', 'down', 'updown', 'random', 'converge'],
          notes: ['Songs play procedural patches as instruments; sample instruments are unsupported (beeps instruments lists the bundled ones, their roots and layer offsets).', 'Times in songs are beats (quarter notes); pattern lengths are bars.', 'The project scale does not apply to songs: the notes are the composition.', 'Songs are trimmed to project.musicLoudness (integrated LUFS); gainDb balances tracks.', 'Full guide: the beeps-music skill and its references/song-format.md.'],
        },
        ...(opts.schema ? { patchSchema: patchJsonSchema(), songSchema: songJsonSchema() } : {}),
      });
    });
}
