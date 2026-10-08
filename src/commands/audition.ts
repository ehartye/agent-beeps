import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { BeepsError } from '../errors.ts';
import { openProject, type OpenProject } from '../project.ts';
import { readSet } from '../sets.ts';
import {
  appendEvent, candidatesFromSet, foldSession, openSession, predictionStats, readEvents, readReveal, readSession,
  sessionDir, writePrediction, type StoredEvent,
} from '../audition/session.ts';
import { AuditionServer, DEFAULT_PORT, SERVER_API, deliveryIpUrls, deliveryUrl, probe, readServerInfo, registerProject, serverInfoFile, sessionIpUrl, sessionUrl, writeServerInfo, type ServerInfo } from '../audition/server.ts';
import { readKit } from '../kit.ts';
import { byteTotals, createDelivery, foldResults, listDeliveries, readDelivery, readDeliveryEvents, resolvePresets, sourceFromFile, sourcesFromAlbum, sourcesFromDir, sourcesFromSet, type Role, type Source } from '../audition/delivery.ts';
import { int } from './shared.ts';

const BIN = join(import.meta.dirname, '..', '..', 'scripts', 'beeps.mjs');
const ACTIONABLE = new Set(['refine', 'ship', 'abandon']);

async function waitFor<T>(fn: () => Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise(r => setTimeout(r, 200));
  }
  return undefined;
}

/** Reuse a healthy server, else start one detached so it outlives this command. */
export async function ensureServer(opts: { host?: string; port?: number } = {}): Promise<ServerInfo> {
  const existing = readServerInfo();
  if (await probe(existing)) {
    if (existing!.api === SERVER_API) return existing!;
    // Keep the token and project registry for the replacement. Clearing the old pid first also
    // prevents the old process's signal handler from deleting this hand-off file as it exits.
    writeServerInfo({ ...existing!, pid: 0 });
    try { process.kill(existing!.pid); } catch { /* already gone */ }
    const stopped = await waitFor(async () => (await probe(existing)) ? undefined : true, 5000);
    if (!stopped) throw new BeepsError('E_SERVER', 'the older audition server did not stop');
  }
  const host = opts.host ?? existing?.host, port = opts.port ?? existing?.port;
  const args = [BIN, 'serve', '--foreground', ...(host ? ['--host', host] : []), ...(port ? ['--port', String(port)] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const up = await waitFor(async () => { const i = readServerInfo(); return i && i.pid === child.pid && (await probe(i)) ? i : undefined; }, 15000);
  if (!up) throw new BeepsError('E_SERVER', 'audition server did not start within 15 s', { hint: `run "beeps serve --foreground" to see why; server file ${serverInfoFile()}` });
  return up;
}

const brief = (p: OpenProject, id: string) => {
  const session = readSession(p, id);
  const state = foldSession(session, readEvents(p, id));
  return {
    id, stage: session.flow === 'explore' && state.stage !== 'abandoned' ? 'explore' : state.stage, flow: session.flow, round: state.round, prompt: session.prompt, mode: session.mode,
    champion: state.champion, shortlist: state.shortlist, loved: state.loved, duds: state.duds,
    duels: state.duels.length, pendingRefine: state.pendingRefine, shipped: state.shipped,
    candidates: state.candidates.map(c => ({ index: c.index, name: c.name, round: c.round, setId: c.setId, look: c.look })),
  };
};

export function registerAuditionCommands(program: Command, io: Io) {
  program.command('serve')
    .description('start (or reuse) the LAN audition server; prints its URL')
    .option('--host <host>', 'interface to bind', '0.0.0.0')
    .option('--port <n>', 'port (next free port if busy)', int, DEFAULT_PORT)
    .option('--foreground', 'run in this process')
    .option('--stop', 'stop the running server')
    .action(async (opts: { host: string; port: number; foreground?: boolean; stop?: boolean }) => {
      if (opts.stop) {
        const info = readServerInfo();
        // Only kill a process that answers as our server: a stale pid may belong to anything by now.
        const alive = await probe(info);
        if (info && alive) { try { process.kill(info.pid); } catch { /* already gone */ } }
        if (info) rmSync(serverInfoFile(), { force: true });
        io.emit({ stopped: alive, pid: alive ? info!.pid : null, ...(info && !alive ? { note: 'server.json was stale; removed it without killing anything' } : {}) });
        return;
      }
      if (!opts.foreground) {
        const info = await ensureServer({ host: opts.host, port: opts.port });
        io.emit({ url: info.url, queue: `${info.url}/?t=${info.token}`, pid: info.pid, projects: info.projects });
        return;
      }
      const { autoRefine } = await import('../mutate.ts').catch(() => ({ autoRefine: undefined }));
      const server = new AuditionServer({ host: opts.host, port: opts.port, onRefine: autoRefine });
      const info = await server.listen();
      writeServerInfo(info);
      io.emit({ url: info.url, queue: `${info.url}/?t=${info.token}`, pid: info.pid });
      const stop = () => { try { if (readServerInfo()?.pid === process.pid) rmSync(serverInfoFile(), { force: true }); } finally { process.exit(0); } };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      await new Promise(() => {}); // serve until killed
    });

  program.command('predict')
    .description('seal your prediction for a set before the owner auditions it')
    .requiredOption('--set <id>', 'candidate set id')
    .requiredOption('--pick <n>', 'the candidate you expect the owner to ship', int)
    .option('--shortlist <list>', 'comma-separated candidates you expect them to like', '')
    .option('--why <text>', 'one line on your reasoning', '')
    .action((opts: { set: string; pick: number; shortlist: string; why: string }) => {
      const p = openProject(io.projectDir());
      const shortlist = opts.shortlist.split(',').filter(Boolean).map(Number);
      io.emit({ sealed: writePrediction(p, opts.set, { pick: opts.pick, shortlist, why: opts.why }), set: opts.set });
    });

  const audition = program.command('audition').description('owner auditions: open, wait, round, status, list, close, stats');

  audition.command('open')
    .description('open a comparison or exploration of a candidate set on the LAN page')
    .requiredOption('--set <id>', 'candidate set id')
    .option('--prompt <text>', 'what the sound is for, shown to the owner')
    .option('--flow <flow>', 'compare: choose between alternatives; explore: listen to different sound roles without duels or predictions', 'compare')
    .option('--mode <mode>', 'live: you answer each refine request with beeps audition wait / mutate / round. handoff: the server breeds refine rounds itself (use when you will not be waiting)', 'live')
    .option('--context <list>', 'kit,bed', 'kit')
    .option('--no-predict', 'open without a prediction (recorded)')
    .action(async (opts: { set: string; prompt?: string; mode: 'live' | 'handoff'; flow: 'compare' | 'explore'; context: string; predict: boolean }) => {
      const p = openProject(io.projectDir());
      const ctx = opts.context.split(',');
      const session = openSession(p, opts.set, { prompt: opts.prompt, mode: opts.mode, flow: opts.flow, context: { kit: ctx.includes('kit'), bed: ctx.includes('bed') }, requirePrediction: opts.predict });
      const info = await ensureServer();
      registerProject(p.paths.root);
      const notes: string[] = [];
      if (ctx.includes('kit') && readKit(p.paths.root).sounds.length === 0) notes.push('the kit is empty, so "play with kit" is unavailable until a sound ships');
      io.emit({ url: sessionUrl(info, session.id), ipUrl: sessionIpUrl(info, session.id), session: session.id, mode: session.mode, flow: session.flow, candidates: session.candidates.length, notes,
        next: session.flow === 'explore' ? 'give the owner the url to explore the labeled sounds; no winner or comparative feedback is requested' : session.mode === 'live'
          ? `give the owner the url, then run beeps audition wait --id ${session.id} (in the background) and answer each event`
          : `give the owner the url and end your turn. Later: beeps audition status --id ${session.id}; once shipped, the patch is in .agent-beeps/patches/ and the kit - export it (beeps export <name> --wav <path>) or play it with the engine` });
    });

  audition.command('formats [sources...]')
    .description('blind-audition compressed delivery formats: encode WAV masters (a bundle directory, WAV files, --set or --album) through the compress presets next to a hidden lossless reference and a low-pass anchor, and serve the rating page')
    .option('--set <id>', 'add the rendered candidates of a set (sfx)')
    .option('--album <id>', 'add the ready tracks of an album (music)')
    .option('--role <role>', 'music, ambience or sfx for every item (default: from sidecars, else music for 20 s and longer, else sfx)')
    .option('--presets <list>', 'comma-separated: wav, mp3-64, mp3-96, mp3-128, mp3-v5, mp3-v2, opus-32, opus-48, opus-64, opus-96, anchor (default: wav,mp3-64,mp3-96,mp3-v5,opus-32,opus-48,opus-64,anchor)')
    .option('--no-anchor', 'leave out the low-pass anchor')
    .option('--catalog <list>', 'seconds of audio per role in the whole library, e.g. music=3600,sfx=400, to project total bytes per preset')
    .option('--title <text>', 'shown to the owner')
    .option('--no-serve', 'encode and write the session only; do not start the server')
    .action(async (sources: string[], opts: { set?: string; album?: string; role?: string; presets?: string; anchor: boolean; catalog?: string; title?: string; serve: boolean }) => {
      const p = openProject(io.projectDir());
      if (opts.role && !['music', 'ambience', 'sfx'].includes(opts.role)) throw new BeepsError('E_USAGE', `--role must be music, ambience or sfx, not ${opts.role}`);
      const role = opts.role as Role | undefined;
      const items: Source[] = [];
      for (const s of sources) items.push(...(existsSync(s) && statSync(s).isDirectory() ? sourcesFromDir(s, role) : [sourceFromFile(s, role)]));
      if (opts.set) items.push(...sourcesFromSet(p, opts.set, role));
      if (opts.album) items.push(...sourcesFromAlbum(p, opts.album, role));
      if (!items.length) throw new BeepsError('E_USAGE', 'name a bundle directory, WAV files, --set or --album');
      const catalog = opts.catalog ? Object.fromEntries(opts.catalog.split(',').map(kv => { const [k, v] = kv.split('='); if (!['music', 'ambience', 'sfx'].includes(k) || !(Number(v) >= 0)) throw new BeepsError('E_USAGE', `--catalog wants role=seconds pairs (music, ambience, sfx), not "${kv}"`); return [k, Number(v)]; })) : undefined;
      const presets = resolvePresets(opts.presets?.split(',').map(x => x.trim()).filter(Boolean), { anchor: opts.anchor });
      const d = createDelivery(p, items, presets, { title: opts.title, catalog, log: s => console.error(s) });
      const dir = join(p.paths.dir, 'delivery', d.id);
      const out: Record<string, unknown> = { id: d.id, items: d.items.length, presets: d.presets.map(x => x.id), roles: [...new Set(d.items.map(i => i.role))], totals: byteTotals(d).map(t => ({ preset: t.preset, bytes: t.bytes, bytesPerSec: t.bytesPerSec, ...(t.projectedBytes !== undefined ? { projectedBytes: t.projectedBytes } : {}) })), dir, encoder: d.encoder };
      if (opts.serve) {
        const info = await ensureServer();
        registerProject(p.paths.root);
        Object.assign(out, { url: deliveryUrl(info, d.id), ipUrls: deliveryIpUrls(info, d.id) });
      }
      out.next = `give the owner the url (a phone uses an ipUrl); they rate each lettered version, then tap Reveal. Then: beeps audition formats-status --id ${d.id}, and beeps taste import ${join(dir, 'results.json')} to log the preference per role`;
      io.emit(out);
    });

  audition.command('formats-status')
    .description('ratings so far for a delivery-format audition: per role, each preset against the hidden reference, listener screening and the smallest acceptable preset (no --id: list them)')
    .option('--id <delivery>', 'delivery audition id')
    .action((opts: { id?: string }) => {
      const p = openProject(io.projectDir());
      if (!opts.id) { io.emit({ deliveries: listDeliveries(p) }); return; }
      const d = readDelivery(p, opts.id);
      const r = foldResults(d, readDeliveryEvents(p, opts.id));
      io.emit({ id: d.id, revealed: r.revealed, rated: r.rows.filter(x => x.rating !== null).length, of: r.rows.length, summary: r.summary, totals: r.totals, device: r.device, notes: r.notes, results: join(p.paths.dir, 'delivery', d.id, 'results.json') });
    });

  audition.command('wait')
    .description('block until the owner asks to refine, ships or abandons; prints that event')
    .requiredOption('--id <session>', 'session id')
    .option('--timeout <s>', 'give up after this many seconds', int, 900)
    .action(async (opts: { id: string; timeout: number }) => {
      const p = openProject(io.projectDir());
      const cursorFile = join(sessionDir(p, opts.id), 'agent-cursor');
      const cursor = existsSync(cursorFile) ? Number(readFileSync(cursorFile, 'utf8')) : 0;
      const found = await waitFor<StoredEvent>(async () => readEvents(p, opts.id).find(e => e.seq > cursor && ACTIONABLE.has(e.type)), opts.timeout * 1000);
      if (!found) { io.emit({ timeout: true, session: brief(p, opts.id) }); return; }
      writeFileSync(cursorFile, String(found.seq));
      const s = brief(p, opts.id);
      const todo = found.type === 'refine'
        ? `breed candidates from #${found.champion} toward ${found.directions.join(', ') || 'surprise'}: beeps mutate <champion-name> --toward ... then beeps audition round --id ${opts.id} --set <new set>`
        : found.type === 'ship' ? 'read the reveal (beeps audition status), wire the shipped patch into the app' : 'the owner abandoned this audition';
      io.emit({ event: found, session: s, todo });
    });

  audition.command('round')
    .description('answer a refine request with a new candidate set (it joins the audition against the champion)')
    .requiredOption('--id <session>', 'session id')
    .requiredOption('--set <id>', 'the new candidate set')
    .action((opts: { id: string; set: string }) => {
      const p = openProject(io.projectDir());
      const state = foldSession(readSession(p, opts.id), readEvents(p, opts.id));
      const start = Math.max(...state.candidates.map(c => c.index)) + 1;
      const r = appendEvent(p, opts.id, { type: 'round', n: state.round + 1, setId: opts.set, candidates: candidatesFromSet(readSet(p, opts.set), state.round + 1, start) });
      io.emit({ stage: r.state.stage, round: r.state.round, lineup: r.state.lineup });
    });

  audition.command('status')
    .description('stage, champion, pending refine request and (after ship) the reveal')
    .requiredOption('--id <session>', 'session id')
    .action((opts: { id: string }) => {
      const p = openProject(io.projectDir());
      const b = brief(p, opts.id);
      const reveal = readReveal(p, opts.id);
      const ship = readEvents(p, opts.id).find(e => e.type === 'ship') as (StoredEvent & { type: 'ship' }) | undefined;
      const shipped = ship ? ship.name ?? b.candidates.find(c => c.index === ship.champion)?.name ?? null : null;
      io.emit({ ...b, reveal, ...(shipped ? { shippedPatch: shipped, next: `wire it in: beeps export ${shipped} --wav <game>/assets/sfx/${shipped}.wav (or play .agent-beeps/patches/${shipped}.json with the engine), then beeps kit check` } : {}) });
    });

  audition.command('list')
    .description('sessions in this project')
    .action(() => {
      const p = openProject(io.projectDir());
      const ids = existsSync(p.paths.sessions) ? readdirSync(p.paths.sessions) : [];
      io.emit({ sessions: ids.flatMap(id => { try { const b = brief(p, id); return [{ id, stage: b.stage, round: b.round, prompt: b.prompt }]; } catch { return []; } }) });
    });

  audition.command('close')
    .description('abandon a session')
    .requiredOption('--id <session>', 'session id')
    .action((opts: { id: string }) => {
      const p = openProject(io.projectDir());
      io.emit({ stage: appendEvent(p, opts.id, { type: 'abandon' }).state.stage });
    });

  audition.command('stats')
    .description('how often agents and the taste model predicted the owner\'s pick')
    .option('--all-projects', 'across every project')
    .action((opts: { allProjects?: boolean }) => {
      const p = opts.allProjects ? null : openProject(io.projectDir());
      io.emit(predictionStats({ project: p?.paths.root }));
    });
}
