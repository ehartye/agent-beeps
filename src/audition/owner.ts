// Optional lifetime lease for automation. Ordinary audition servers have no owner and persist.
import { connect, type Socket } from 'node:net';
import { BeepsError } from '../errors.ts';

export function serverOwner(): { port: number; token: string } | undefined {
  const value = process.env.AGENT_BEEPS_SERVER_OWNER;
  if (!value) return undefined;
  try {
    const owner = JSON.parse(value);
    if (!process.env.AGENT_BEEPS_HOME || !Number.isInteger(owner.port) || owner.port < 1 || owner.port > 65535 || !/^[a-f0-9]{64}$/.test(owner.token)) throw new Error();
    return owner;
  } catch { throw new BeepsError('E_SERVER', 'invalid audition owner lease; an explicit isolated AGENT_BEEPS_HOME and owner endpoint are required'); }
}

/** The live connection, not a PID or port scan, defines ownership even after the starter CLI exits. */
export async function attachServerOwner(stop: () => void): Promise<Socket | undefined> {
  const owner = serverOwner();
  if (!owner) return undefined;
  const socket = connect({ host: '127.0.0.1', port: owner.port });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new BeepsError('E_SERVER', 'audition owner did not acknowledge startup')); }, 5000);
    const fail = () => { clearTimeout(timer); reject(new BeepsError('E_SERVER', 'audition owner disconnected during startup')); };
    socket.once('error', fail); socket.once('close', fail);
    let input = '';
    const data = (chunk: Buffer) => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      clearTimeout(timer); socket.off('data', data); socket.off('error', fail); socket.off('close', fail);
      if (input !== 'owned\n') { socket.destroy(); reject(new BeepsError('E_SERVER', 'audition owner rejected startup')); return; }
      socket.on('error', stop); socket.on('end', stop); socket.on('close', stop);
      socket.on('data', stop);
      resolve();
    };
    socket.on('data', data);
    socket.once('connect', () => socket.write(owner.token + '\n'));
  });
  return socket;
}
