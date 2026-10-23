// beeps hook prepare | play | event | settings | status | enable | disable: opt-in notification sounds for an agent session (src/hook.ts).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { getArchetype, sampleArchetype } from '../archetypes.ts';
import { BeepsError } from '../errors.ts';
import { decide, HOOK_RECIPES, HOOK_SOUNDS, hasExecutable, hooksConfigFile, hooksDir, hooksState, play, playCommand, setHooksEnabled, settingsSnippet, soundFile, type HookSound } from '../hook.ts';
import { renderAndMeasure } from '../render/pipeline.ts';
import { parseProject } from '../schema/project.ts';
import { withHost } from './shared.ts';

const RUNNER = join(import.meta.dirname, '..', '..', 'scripts', 'run-managed.js');

function sound(name: string): HookSound {
  if (!(HOOK_SOUNDS as readonly string[]).includes(name)) throw new BeepsError('E_USAGE', `no hook sound "${name}"`, { hint: `one of ${HOOK_SOUNDS.join(', ')}`, received: name });
  return name as HookSound;
}

export function registerHookCommands(program: Command, io: Io) {
  const hook = program.command('hook').description('opt-in notification sounds for a coding agent session: prepare four short sounds, then play them on Stop, Notification and build/test results');

  hook.command('prepare')
    .description('render the four hook sounds (done, success, failure, attention) from the library into the beeps home folder, quieter than a game sound so they do not startle; needs Chromium once, never at play time')
    .option('--force', 'render again even when a sound is already prepared')
    .action(async (opts: { force?: boolean }) => {
      mkdirSync(hooksDir(), { recursive: true });
      // Hook sounds sit well under a game sound: they come at any moment, on the user's own speakers.
      const project = parseProject({ schema: 'beeps/project@1', targetLoudness: -26 });
      const todo = HOOK_SOUNDS.filter(n => opts.force || !existsSync(soundFile(n)));
      const items = todo.map(n => ({ n, patch: { ...sampleArchetype(getArchetype(HOOK_RECIPES[n].archetype), HOOK_RECIPES[n].seed, 1)[0], name: `hook-${n}` } }));
      const out = items.length ? await withHost(host => renderAndMeasure(host, items.map(i => ({ patch: i.patch, seed: 1 })), { project, rendersDir: join(hooksDir(), 'cache') })) : [];
      const failed: { name: string; error: string }[] = [];
      out.forEach((o, i) => { if (o.ok) copyFileSync(o.wavPath, soundFile(items[i].n)); else failed.push({ name: items[i].n, error: o.error }); });
      io.emit({
        dir: hooksDir(),
        sounds: HOOK_SOUNDS.map(n => ({ name: n, file: soundFile(n), prepared: existsSync(soundFile(n)), ...HOOK_RECIPES[n] })),
        rendered: todo.length - failed.length,
        ...(failed.length ? { failed } : {}),
        next: 'beeps hook settings prints the settings.json fragment; beeps hook enable turns the sounds on',
      });
      if (failed.length) process.exitCode = 1;
    });

  hook.command('play <name>')
    .description('play a prepared hook sound now (done, success, failure, attention); does nothing, and exits 0, when hooks are off, the sound is not prepared or no audio player is found')
    .action((name: string) => {
      const n = sound(name);
      const state = hooksState();
      if (!state.enabled) { io.emit({ played: false, reason: 'hooks are off: beeps hook enable, or BEEPS_HOOKS=1' }); return; }
      io.emit({ sound: n, ...play(n) });
    });

  hook.command('event')
    .description('read a Claude Code hook payload (JSON on stdin) and play the sound it deserves: Stop is done, Notification is attention, a Bash build/test/lint result is success only on an explicit exit status of 0 and failure on an explicit non-zero one, and anything else is silent. Always exits 0 so it never fails the agent\'s turn')
    .action(() => {
      try {
        const text = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
        let payload: unknown;
        try { payload = text.trim() ? JSON.parse(text) : undefined; } catch { payload = undefined; }
        const d = decide(payload);
        const state = hooksState();
        const result = d.sound && state.enabled ? play(d.sound) : undefined;
        io.emit({ event: (payload as { hook_event_name?: string } | undefined)?.hook_event_name ?? null, sound: d.sound, reason: d.reason, enabled: state.enabled, ...(result ? { played: result.played, ...(result.played ? {} : { notPlayedBecause: result.reason }) } : {}) });
      } catch (e) {
        io.emit({ sound: null, error: (e as Error).message });
      }
    });

  hook.command('settings')
    .description('print the settings.json fragment that runs beeps hook event on Stop, Notification and Bash results; paste it into ~/.claude/settings.json (the plugin ships no hooks of its own, so nothing plays until you do)')
    .action(() => io.emit({ settings: settingsSnippet(RUNNER), note: 'merge the "hooks" key into your settings.json, then beeps hook prepare and beeps hook enable' }));

  hook.command('status')
    .description('whether hook sounds are on and why, which sounds are prepared, and the audio player this machine would use')
    .action(() => {
      const state = hooksState();
      const player = playCommand(process.platform, '<file>', hasExecutable);
      io.emit({
        enabled: state.enabled, source: state.source, config: hooksConfigFile(), dir: hooksDir(),
        sounds: HOOK_SOUNDS.map(n => ({ name: n, prepared: existsSync(soundFile(n)), when: HOOK_RECIPES[n].when })),
        player: player ? player.command : null,
      });
    });

  hook.command('enable').description('turn hook sounds on (writes hooks.json in the beeps home folder; BEEPS_HOOKS=0 still overrides)').action(() => io.emit({ enabled: true, config: setHooksEnabled(true) }));
  hook.command('disable').description('turn hook sounds off').action(() => io.emit({ enabled: false, config: setHooksEnabled(false) }));
}
