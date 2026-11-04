import { acquireStateGuard } from '../../src/state-guard.ts';
import { updateKit, addToKit } from '../../src/kit.ts';
import { registerProject, writeServerInfo } from '../../src/audition/server.ts';
import { runBuild } from '../../src/build/build.ts';
import { loadConfig } from '../../src/build/config.ts';
const [mode, target, name] = process.argv.slice(2);
const send = (message: unknown) => process.send!(message);
let release: (() => void) | undefined;
send({ ready: true });
process.on('message', async message => {
  try {
    if (message === 'hold') {
      release = acquireStateGuard(target);
      send({ held: true });
    } else if (message === 'release') {
      release!(); send({ released: true });
    } else if (message === 'write') {
      if (mode === 'build') await runBuild(loadConfig(target), { only: [name] });
      if (mode === 'kit') updateKit(target, current => addToKit(current, { name, family: 'test', priority: 1 }));
      if (mode === 'register') registerProject(name);
      if (mode === 'server') writeServerInfo(JSON.parse(name));
      send({ written: true });
    } else if (message === 'exit') process.disconnect!();
  } catch (error) { const e = error as Error & { code?: string }; send({ error: e.code ?? 'unknown', message: e.message }); }
});
