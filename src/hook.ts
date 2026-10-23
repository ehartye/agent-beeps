// Notification sounds for a coding agent session, opt-in. A Claude Code hook runs a command on an event; `beeps hook event` turns the event into
// one of four prepared sounds and plays it. The rule it keeps: a success sound is only played on evidence of success (an explicit exit status
// of 0), never on the mere absence of an error.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beepsHome } from './taste/verdicts.ts';

export const HOOK_SOUNDS = ['done', 'success', 'failure', 'attention'] as const;
export type HookSound = (typeof HOOK_SOUNDS)[number];

/** Which archetype and seed each prepared sound is sampled from, so `hook prepare` makes the same four files on every machine. */
export const HOOK_RECIPES: Record<HookSound, { archetype: string; seed: number; when: string }> = {
  done: { archetype: 'notification', seed: 3, when: 'the agent finished its turn (Stop)' },
  success: { archetype: 'coin', seed: 5, when: 'a build, test or lint command exited with status 0' },
  failure: { archetype: 'no', seed: 2, when: 'a build, test or lint command exited with a non-zero status' },
  attention: { archetype: 'alarm', seed: 7, when: 'the agent needs you (Notification)' },
};

export const hooksDir = () => join(beepsHome(), 'hooks');
export const hooksConfigFile = () => join(beepsHome(), 'hooks.json');
export const soundFile = (name: HookSound) => join(hooksDir(), `${name}.wav`);

/** The commands whose result is worth a sound: building, testing, linting. Any other Bash command is silent. */
export const WATCHED_COMMANDS = /\b(test|tests|vitest|jest|mocha|pytest|tox|rspec|build|tsc|lint|eslint|make|cmake|cargo|gradle|mvn|dotnet|go (test|build|vet)|npm run|pnpm|yarn)\b/i;

export interface HookState { enabled: boolean; source: 'BEEPS_HOOKS' | 'config' | 'default' }

/** Hooks are off unless `BEEPS_HOOKS=1` or the config file says `"enabled": true`; `BEEPS_HOOKS=0` forces them off. */
export function hooksState(env: NodeJS.ProcessEnv = process.env): HookState {
  if (env.BEEPS_HOOKS === '1') return { enabled: true, source: 'BEEPS_HOOKS' };
  if (env.BEEPS_HOOKS === '0') return { enabled: false, source: 'BEEPS_HOOKS' };
  try {
    const c = JSON.parse(readFileSync(hooksConfigFile(), 'utf8')) as { enabled?: unknown };
    if (c.enabled === true) return { enabled: true, source: 'config' };
    return { enabled: false, source: 'config' };
  } catch { return { enabled: false, source: 'default' }; }
}

export function setHooksEnabled(enabled: boolean): string {
  mkdirSync(beepsHome(), { recursive: true });
  writeFileSync(hooksConfigFile(), JSON.stringify({ enabled }, null, 2) + '\n');
  return hooksConfigFile();
}

export interface HookDecision { sound: HookSound | null; reason: string }

/**
 * What a Claude Code hook payload (JSON on stdin) should play. Nothing, with a reason, whenever the payload does not say enough:
 * a `PostToolUse` Bash result plays success only for an explicit exit status of 0 and failure for an explicit non-zero one.
 */
export function decide(payload: unknown): HookDecision {
  if (!payload || typeof payload !== 'object') return { sound: null, reason: 'the payload is not a JSON object' };
  const p = payload as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: { command?: unknown }; tool_response?: Record<string, unknown> };
  switch (p.hook_event_name) {
    case 'Stop': return { sound: 'done', reason: 'the agent finished its turn' };
    case 'Notification': return { sound: 'attention', reason: 'the agent is asking for attention' };
    case 'PostToolUse': {
      if (p.tool_name !== 'Bash') return { sound: null, reason: `${String(p.tool_name)} results are not watched` };
      const command = typeof p.tool_input?.command === 'string' ? p.tool_input.command : '';
      if (!WATCHED_COMMANDS.test(command)) return { sound: null, reason: 'the command is not a build, test or lint command' };
      const r = p.tool_response ?? {};
      const code = [r.exit_code, r.exitCode, r.returncode, r.status].find(v => typeof v === 'number');
      if (typeof code !== 'number') return { sound: null, reason: 'the result carries no exit status, so success cannot be claimed' };
      return code === 0 ? { sound: 'success', reason: 'exit status 0' } : { sound: 'failure', reason: `exit status ${code}` };
    }
    default: return { sound: null, reason: `${String(p.hook_event_name)} is not a watched event` };
  }
}

export interface PlayCommand { command: string; args: string[] }

/** The player command for `file` on `platform`, given which executables exist; null when there is none. */
export function playCommand(platform: NodeJS.Platform, file: string, has: (exe: string) => boolean): PlayCommand | null {
  if (platform === 'win32') {
    return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer '${file.replaceAll("'", "''")}').PlaySync()`] };
  }
  if (platform === 'darwin') return has('afplay') ? { command: 'afplay', args: [file] } : null;
  if (has('paplay')) return { command: 'paplay', args: [file] };
  if (has('aplay')) return { command: 'aplay', args: ['-q', file] };
  if (has('play')) return { command: 'play', args: ['-q', file] };
  return null;
}

export const hasExecutable = (exe: string): boolean => spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { stdio: 'ignore' }).status === 0;

/** Two sounds closer together than this are one sound too many: the second is skipped. */
export const MIN_GAP_MS = 400;

export interface PlayResult { played: boolean; reason?: string; command?: string }

/** Play a prepared sound without waiting for it. Never throws: a hook must not fail the agent's turn. */
export function play(name: HookSound, { dryRun = process.env.BEEPS_HOOKS_DRY_RUN === '1', now = Date.now() } = {}): PlayResult {
  const file = soundFile(name);
  if (!existsSync(file)) return { played: false, reason: `${name}.wav is not prepared: run beeps hook prepare` };
  const stamp = join(hooksDir(), '.last-played');
  try {
    if (existsSync(stamp) && now - statSync(stamp).mtimeMs < MIN_GAP_MS) return { played: false, reason: 'another sound played a moment ago' };
  } catch { /* no stamp */ }
  const cmd = playCommand(process.platform, file, hasExecutable);
  if (!cmd) return { played: false, reason: 'no audio player found (afplay, paplay, aplay or play)' };
  const text = [cmd.command, ...cmd.args].join(' ');
  try {
    // The stamp is written before the dry-run return, so a dry run rate-limits exactly as a real one does.
    writeFileSync(stamp, '');
    utimesSync(stamp, new Date(now), new Date(now));
    if (dryRun) return { played: true, command: text, reason: 'dry run: not started' };
    spawn(cmd.command, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { played: true, command: text };
  } catch (e) { return { played: false, reason: (e as Error).message }; }
}

/** The `settings.json` fragment that wires the three events to `beeps hook event`. `runner` is the path of the plugin's run-managed.js. */
export function settingsSnippet(runner: string): Record<string, unknown> {
  const command = `node "${runner}" hook event`;
  const hook = [{ type: 'command', command }];
  return { hooks: { Stop: [{ hooks: hook }], Notification: [{ hooks: hook }], PostToolUse: [{ matcher: 'Bash', hooks: hook }] } };
}
