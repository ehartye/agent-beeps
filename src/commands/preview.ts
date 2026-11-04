import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { BeepsError } from '../errors.ts';
import { openProject } from '../project.ts';
import { probe, readServerInfo, SERVER_API, type ServerInfo } from '../audition/server.ts';
import type { PreviewKind } from '../audition/preview.ts';

async function request(info: ServerInfo, path: string, method: string, body?: unknown) {
  const host = info.host === '0.0.0.0' || info.host === '::' ? '127.0.0.1' : info.host;
  const response = await fetch(`http://${host}:${info.port}${path}`, {
    method, headers: { 'x-beeps-token': info.token, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
  });
  const result = await response.json() as any;
  if (!response.ok) throw new BeepsError('E_SERVER', result.error?.message ?? 'preview request failed');
  return result;
}
export const createPreview = (info: ServerInfo, root: string, kind: PreviewKind, target: string, feedback = false, seconds = 3600) =>
  request(info, '/api/previews', 'POST', { root, kind, target, feedback, seconds });

export function registerPreviewCommands(program: Command, io: Io) {
  const preview = program.command('preview').description('temporary shareable links for one audition, album or delivery');
  const running = async () => {
    const info = readServerInfo();
    if (!info || !(await probe(info)) || info.api !== SERVER_API)
      throw new BeepsError('E_SERVER', 'a current Beeps server must already be running; preview never starts or replaces a server');
    return info;
  };
  preview.command('create').description('create a read-only share link; optionally permit scoped feedback')
    .requiredOption('--kind <kind>', 'session, album or delivery')
    .requiredOption('--id <id>', 'preview target id')
    .option('--feedback', 'allow ratings and notes, never ship, refine, abandon or reveal')
    .option('--seconds <seconds>', 'lifetime: 60–86400 seconds', Number, 3600)
    .action(async opts => io.emit(await createPreview(await running(), openProject(io.projectDir()).paths.root, opts.kind, opts.id, opts.feedback, opts.seconds)));
  preview.command('revoke').description('revoke a share link and its browser sessions immediately')
    .requiredOption('--id <id>', 'share id returned by preview create (not the target id)')
    .action(async opts => {
      if (!/^[a-f0-9]{32}$/.test(opts.id)) throw new BeepsError('E_USAGE', 'invalid preview share id');
      io.emit(await request(await running(), `/api/previews/${opts.id}`, 'DELETE'));
    });
}
