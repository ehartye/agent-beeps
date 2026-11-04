// The coordinator owns both the temporary root and daemon leases. No age-based deletion of other runs.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerOwner } from './helpers/server-owner.ts';

export async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'beeps-test-run-'));
  const owner = await createServerOwner();
  const keys = ['TMPDIR', 'TMP', 'TEMP', 'AGENT_BEEPS_HOME', 'AGENT_BEEPS_SERVER_OWNER'];
  const previous = keys.map(key => process.env[key]);
  for (const key of keys.slice(0, 3)) process.env[key] = root;
  process.env.AGENT_BEEPS_HOME = join(root, 'home');
  mkdirSync(process.env.AGENT_BEEPS_HOME);
  process.env.AGENT_BEEPS_SERVER_OWNER = owner.value;
  return async () => {
    try {
      const report = await owner.close();
      console.log(`audition daemon drain: ${JSON.stringify(report)}`);
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } finally {
      keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    }
  };
}
