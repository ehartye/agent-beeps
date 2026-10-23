// 0.30.0: opt-in notification sounds for an agent session. The rule under test: a success sound needs evidence of success.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, hooksConfigFile, hooksDir, hooksState, MIN_GAP_MS, play, playCommand, setHooksEnabled, settingsSnippet, soundFile, WATCHED_COMMANDS } from '../src/hook.ts';
import { readWav } from '../src/audio/wav.ts';
import { chromiumAvailable } from '../src/render/host.ts';
import { beeps } from './helpers/cli.ts';

const bin = join(import.meta.dirname, '..', 'scripts', 'beeps.mjs');
const post = (command: string, response: Record<string, unknown>, tool = 'Bash') => ({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { command }, tool_response: response });
const SAVED = { home: process.env.AGENT_BEEPS_HOME, hooks: process.env.BEEPS_HOOKS, dry: process.env.BEEPS_HOOKS_DRY_RUN };

beforeEach(() => {
  process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-hooks-'));
  delete process.env.BEEPS_HOOKS;
  delete process.env.BEEPS_HOOKS_DRY_RUN;
});
afterEach(() => {
  for (const [k, v] of [['AGENT_BEEPS_HOME', SAVED.home], ['BEEPS_HOOKS', SAVED.hooks], ['BEEPS_HOOKS_DRY_RUN', SAVED.dry]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

/** A prepared sound that is only a file: enough for everything but the audio itself. */
const fakeSound = (name: 'done' | 'success' | 'failure' | 'attention') => { mkdirSync(hooksDir(), { recursive: true }); writeFileSync(soundFile(name), 'RIFF'); };

describe('what an event deserves', () => {
  it('plays done on Stop and attention on Notification', () => {
    expect(decide({ hook_event_name: 'Stop' }).sound).toBe('done');
    expect(decide({ hook_event_name: 'Notification', message: 'needs permission' }).sound).toBe('attention');
  });

  it('plays success only for an explicit exit status of 0', () => {
    expect(decide(post('npm test', { exit_code: 0 }))).toMatchObject({ sound: 'success', reason: 'exit status 0' });
    expect(decide(post('npx vitest run', { exitCode: 0 })).sound).toBe('success');
    expect(decide(post('cargo build', { returncode: 0 })).sound).toBe('success');
  });

  it('plays failure only for an explicit non-zero exit status', () => {
    expect(decide(post('npm test', { exit_code: 1 }))).toMatchObject({ sound: 'failure', reason: 'exit status 1' });
    expect(decide(post('tsc --noEmit', { exitCode: 2 })).sound).toBe('failure');
  });

  it('never claims success without evidence', () => {
    for (const response of [{}, { is_error: false }, { stdout: 'all tests passed', stderr: '' }, { interrupted: false }, { exit_code: '0' }, { exit_code: null }]) {
      const d = decide(post('npm test', response));
      expect(d.sound, JSON.stringify(response)).toBeNull();
      expect(d.reason).toMatch(/no exit status/);
    }
    expect(decide({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }).sound).toBeNull();
  });

  it('stays silent for commands and tools it was not asked to watch', () => {
    expect(decide(post('ls -la', { exit_code: 0 })).sound).toBeNull();
    expect(decide(post('git status', { exit_code: 1 })).sound).toBeNull();
    expect(decide(post('npm test', { exit_code: 0 }, 'Edit')).sound).toBeNull();
    expect(decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }).sound).toBeNull();
    for (const bad of [undefined, null, 'Stop', 3, []]) expect(decide(bad).sound, String(bad)).toBeNull();
  });

  it('recognises the usual build, test and lint commands', () => {
    for (const c of ['npm test', 'npx vitest run --maxWorkers=2', 'pytest -q', 'cargo build --release', 'go test ./...', 'npm run lint', 'make', 'tsc --noEmit']) expect(WATCHED_COMMANDS.test(c), c).toBe(true);
    for (const c of ['ls', 'cat README.md', 'git commit -m x', 'echo hello']) expect(WATCHED_COMMANDS.test(c), c).toBe(false);
  });
});

describe('whether hooks are on', () => {
  it('is off by default, on from the config file or BEEPS_HOOKS=1, and BEEPS_HOOKS=0 wins', () => {
    expect(hooksState()).toEqual({ enabled: false, source: 'default' });
    setHooksEnabled(true);
    expect(hooksState()).toEqual({ enabled: true, source: 'config' });
    expect(hooksState({ BEEPS_HOOKS: '0' })).toEqual({ enabled: false, source: 'BEEPS_HOOKS' });
    setHooksEnabled(false);
    expect(hooksState()).toEqual({ enabled: false, source: 'config' });
    expect(hooksState({ BEEPS_HOOKS: '1' })).toEqual({ enabled: true, source: 'BEEPS_HOOKS' });
    writeFileSync(hooksConfigFile(), 'not json');
    expect(hooksState().enabled).toBe(false);
  });
});

describe('the audio player', () => {
  const has = (...exes: string[]) => (e: string) => exes.includes(e);
  it('picks the platform player, quoting the path on Windows', () => {
    expect(playCommand('win32', "C:\\a b\\it's.wav", has())!.args.join(' ')).toContain("'C:\\a b\\it''s.wav'");
    expect(playCommand('darwin', '/x.wav', has('afplay'))).toEqual({ command: 'afplay', args: ['/x.wav'] });
    expect(playCommand('darwin', '/x.wav', has())).toBeNull();
    expect(playCommand('linux', '/x.wav', has('aplay', 'play'))).toEqual({ command: 'aplay', args: ['-q', '/x.wav'] });
    expect(playCommand('linux', '/x.wav', has('paplay', 'aplay'))!.command).toBe('paplay');
    expect(playCommand('linux', '/x.wav', has())).toBeNull();
  });
});

describe('playing', () => {
  it('says why nothing played when the sound is not prepared', () => {
    expect(play('done')).toMatchObject({ played: false, reason: expect.stringContaining('beeps hook prepare') });
  });

  it('skips a second sound that comes right after the first', () => {
    process.env.BEEPS_HOOKS_DRY_RUN = '1';
    fakeSound('done');
    const t = Date.now();
    const first = play('done', { now: t });
    if (!first.played && /no audio player/.test(first.reason ?? '')) return; // a machine with no player: nothing more to check
    expect(first.played).toBe(true);
    expect(play('done', { now: t + 50 })).toMatchObject({ played: false, reason: expect.stringContaining('moment ago') });
    expect(play('done', { now: t + MIN_GAP_MS + 1000 }).played).toBe(true);
  });
});

describe('the settings fragment', () => {
  it('wires Stop, Notification and Bash results to beeps hook event, and is plain JSON', () => {
    const s = JSON.parse(JSON.stringify(settingsSnippet('/p/scripts/run-managed.js'))) as { hooks: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]> };
    expect(Object.keys(s.hooks)).toEqual(['Stop', 'Notification', 'PostToolUse']);
    expect(s.hooks.PostToolUse[0].matcher).toBe('Bash');
    for (const entries of Object.values(s.hooks)) expect(entries[0].hooks[0]).toEqual({ type: 'command', command: 'node "/p/scripts/run-managed.js" hook event' });
  });

  it('is what hook settings prints', () => {
    const r = beeps(process.cwd(), 'hook', 'settings');
    expect(r.status).toBe(0);
    expect(Object.keys(r.out.settings.hooks)).toEqual(['Stop', 'Notification', 'PostToolUse']);
    expect(r.out.settings.hooks.Stop[0].hooks[0].command).toMatch(/run-managed\.js" hook event$/);
  });
});

describe('the commands', () => {
  const event = (payload: unknown, env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [bin, 'hook', 'event'], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
    return { status: r.status, out: JSON.parse(r.stdout) };
  };

  it('does nothing while hooks are off, and still exits 0', () => {
    fakeSound('done');
    const r = event({ hook_event_name: 'Stop' });
    expect(r.status).toBe(0);
    expect(r.out).toMatchObject({ event: 'Stop', sound: 'done', enabled: false });
    expect(r.out.played).toBeUndefined();
  });

  it('plays when on, and says so', () => {
    fakeSound('done');
    const r = event({ hook_event_name: 'Stop' }, { BEEPS_HOOKS: '1', BEEPS_HOOKS_DRY_RUN: '1' });
    expect(r.status).toBe(0);
    expect(r.out.enabled).toBe(true);
    expect(typeof r.out.played).toBe('boolean');
  });

  it('survives a payload that is not JSON, an empty one and a missing sound, always with exit 0', () => {
    for (const payload of ['not json', '', '{}']) {
      const r = event(payload, { BEEPS_HOOKS: '1', BEEPS_HOOKS_DRY_RUN: '1' });
      expect(r.status, payload).toBe(0);
      expect(r.out.sound).toBeNull();
    }
    const missing = event({ hook_event_name: 'Notification' }, { BEEPS_HOOKS: '1', BEEPS_HOOKS_DRY_RUN: '1' });
    expect(missing.status).toBe(0);
    expect(missing.out).toMatchObject({ sound: 'attention', played: false });
    expect(missing.out.notPlayedBecause).toMatch(/hook prepare/);
  });

  it('plays only a known sound, and only when on', () => {
    expect(beeps(process.cwd(), 'hook', 'play', 'bogus').err.code).toBe('E_USAGE');
    expect(beeps(process.cwd(), 'hook', 'play', 'done').out).toMatchObject({ played: false, reason: expect.stringContaining('hooks are off') });
  });

  it('reports its state, and enable and disable change it', () => {
    expect(beeps(process.cwd(), 'hook', 'status').out).toMatchObject({ enabled: false, source: 'default' });
    expect(beeps(process.cwd(), 'hook', 'enable').out.enabled).toBe(true);
    const on = beeps(process.cwd(), 'hook', 'status').out;
    expect(on).toMatchObject({ enabled: true, source: 'config' });
    expect(on.sounds.map((s: { name: string }) => s.name)).toEqual(['done', 'success', 'failure', 'attention']);
    expect(beeps(process.cwd(), 'hook', 'disable').out.enabled).toBe(false);
  });
});

describe.skipIf(!(await chromiumAvailable()))('preparing the sounds', () => {
  it('renders four short, quiet sounds once, and not again', () => {
    const first = beeps(process.cwd(), 'hook', 'prepare');
    expect(first.status).toBe(0);
    expect(first.out.rendered).toBe(4);
    for (const n of ['done', 'success', 'failure', 'attention'] as const) {
      const wav = readWav(readFileSync(soundFile(n)));
      expect(wav.channels[0].length / wav.sampleRate, n).toBeLessThan(1.2);
      expect(wav.channels[0].length / wav.sampleRate, n).toBeGreaterThan(0.1);
      const peak = wav.channels.reduce((m, c) => Math.max(m, c.reduce((a, v) => Math.max(a, Math.abs(v)), 0)), 0);
      expect(peak, n).toBeLessThan(0.9);
    }
    expect(beeps(process.cwd(), 'hook', 'prepare').out.rendered).toBe(0);
    expect(beeps(process.cwd(), 'hook', 'prepare', '--force').out.rendered).toBe(4);
  });
});
