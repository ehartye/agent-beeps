import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { ERROR_CODES } from '../errors.ts';
import { patchJsonSchema, SOURCE_TYPES } from '../schema/patch.ts';
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
      io.emit({
        version: VERSION,
        engine: ENGINE_VERSION,
        sampleRate: 48000,
        commands: program.commands.map(c => ({ name: c.name(), description: c.description() })),
        sourceTypes: SOURCE_TYPES,
        scales: Object.keys(SCALES),
        reverbPresets: Object.keys(REVERB_PRESETS),
        archetypes: await archetypeNames(),
        refineDirections: ['brighter', 'darker', 'punchier', 'softer', 'shorter', 'longer', 'less-harsh', 'more-character'],
        tasteFeatures: FEATURE_NAMES,
        errorCodes: ERROR_CODES,
        notes: [
          'Patches never carry a loudness literal: the renderer trims every sound to the project loudness target.',
          'lowpass/highpass take resonanceDb (Chromium treats their Q as dB); bandpass/notch/peaking take q.',
          'Pitched sources snap to the project scale when scale.snap is true.',
          'A repo that commits its patch files: beeps sync <dir> mirrors them into the project, then lint, kit add and kit check take the names.',
          'Hand-made variants authored as separate patches (names <stem>-<n> in one family, or a shared meta.variantOf) count toward variation-on-repeating.',
          'Every render writes a look.png (waveform, spectrogram, features): look at it; you cannot hear.',
        ],
        example: EXAMPLE,
        music: {
          chordQualities: Object.keys(QUALITIES).filter(Boolean),
          patternKinds: ['notes', 'chords', 'arp', 'bass', 'steps'],
          arpShapes: ['up', 'down', 'updown', 'random', 'converge'],
          notes: ['Songs play patches as instruments (beeps instruments lists the bundled ones, their roots and layer offsets).', 'Times in songs are beats (quarter notes); pattern lengths are bars.', 'The project scale does not apply to songs: the notes are the composition.', 'Songs are trimmed to project.musicLoudness (integrated LUFS); gainDb balances tracks.', 'Full guide: the beeps-music skill and its references/song-format.md.'],
        },
        ...(opts.schema ? { patchSchema: patchJsonSchema(), songSchema: songJsonSchema() } : {}),
      });
    });
}
