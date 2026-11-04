// Cancellation regression fixture: delay registry removal after the real listener closes.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
const remove = fs.rmSync;
fs.rmSync = function (path, options) {
  if (basename(String(path)) === 'server.json') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  return remove(path, options);
};
syncBuiltinESMExports();
