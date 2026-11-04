import { randomBytes } from 'node:crypto';
import { createServer, type AddressInfo, type Socket } from 'node:net';

/** Keep the lease in the coordinator, whose event loop remains live during spawnSync tests. */
export async function createServerOwner() {
  const token = randomBytes(32).toString('hex');
  const clients = new Map<Socket, { owned: boolean; drained: boolean }>();
  let started = 0, drained = 0, closing = false;
  const server = createServer(socket => {
    const state = { owned: false, drained: false }; clients.set(socket, state);
    let input = '';
    socket.setTimeout(5000, () => { if (!state.owned) socket.destroy(); });
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input += chunk.toString();
      if (input.length > 256) { socket.destroy(); return; }
      for (let newline; (newline = input.indexOf('\n')) >= 0;) {
        const line = input.slice(0, newline); input = input.slice(newline + 1);
        if (!state.owned) {
          if (closing || line !== token) { socket.destroy(); return; }
          state.owned = true; started++; socket.setTimeout(0); socket.write('owned\n');
        } else if (line === 'drained' && !state.drained) { state.drained = true; drained++; }
      }
    });
    socket.on('close', () => clients.delete(socket));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = JSON.stringify({ port: (server.address() as AddressInfo).port, token });
  return { value, async close() {
    closing = true;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const [socket, state] of clients) { if (state.owned) socket.write('stop\n'); else socket.destroy(); }
    const deadline = Date.now() + 7000;
    while (clients.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    for (const socket of clients.keys()) socket.destroy();
    await closed;
    const report = { started, drained, confirmed: started === drained };
    if (!report.confirmed) throw new Error(`audition daemon drain unconfirmed: ${JSON.stringify(report)}`);
    return report;
  } };
}
