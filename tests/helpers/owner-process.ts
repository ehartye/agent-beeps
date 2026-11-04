import { createServerOwner } from './server-owner.ts';
const owner = await createServerOwner();
process.send!(owner.value);
process.on('disconnect', () => process.exit(0));
// The cancellation test kills this exact child handle; socket EOF must stop its daemon.
