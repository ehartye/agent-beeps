// The runtime example library (library/sounds/runtime-examples): patches that declare xRuntime inputs, with the project and
// kit seeds they were authored against.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePatch, type Patch } from '../../src/schema/patch.ts';
import { parseProject } from '../../src/schema/project.ts';

export const EXAMPLES = join(import.meta.dirname, '..', '..', 'library', 'sounds', 'runtime-examples');

export function example(name: string): Patch {
  const r = parsePatch(JSON.parse(readFileSync(join(EXAMPLES, 'patches', `${name}.json`), 'utf8')));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.patch;
}

export const exampleProject = () => parseProject(JSON.parse(readFileSync(join(EXAMPLES, 'project.json'), 'utf8')));
