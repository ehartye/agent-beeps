// The project store: .agent-beeps/ inside the repo being scored.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BeepsError } from './errors.ts';
import { parsePatch, type Patch } from './schema/patch.ts';
import { defaultProject, parseProject, type Project } from './schema/project.ts';

export const DIR = '.agent-beeps';

export interface ProjectPaths {
  root: string; dir: string; projectFile: string;
  patches: string; sets: string; sessions: string; taste: string; renders: string; kit: string;
}

export function pathsFor(root: string): ProjectPaths {
  const dir = join(root, DIR);
  return {
    root, dir, projectFile: join(dir, 'project.json'),
    patches: join(dir, 'patches'), sets: join(dir, 'sets'), sessions: join(dir, 'sessions'),
    taste: join(dir, 'taste'), renders: join(dir, 'renders'), kit: join(dir, 'kit.json'),
  };
}

/** Nearest ancestor of `start` holding .agent-beeps/project.json. */
export function findProjectRoot(start: string): string | undefined {
  let cur = resolve(start);
  while (true) {
    if (existsSync(join(cur, DIR, 'project.json'))) return cur;
    const up = dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

export interface OpenProject { paths: ProjectPaths; project: Project }

export function openProject(start: string): OpenProject {
  const root = findProjectRoot(start);
  if (!root) throw new BeepsError('E_PROJECT', `no ${DIR}/project.json in ${resolve(start)} or its parents`, { hint: 'run "beeps init" in the project root' });
  const paths = pathsFor(root);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(paths.projectFile, 'utf8')); } catch (e) {
    throw new BeepsError('E_PROJECT', `cannot read ${paths.projectFile}: ${(e as Error).message}`);
  }
  try { return { paths, project: parseProject(raw) }; } catch (e) {
    throw new BeepsError('E_SCHEMA', `invalid ${paths.projectFile}: ${(e as Error).message}`);
  }
}

export function initProject(root: string, overrides: Partial<Pick<Project, 'targetLoudness'>> & { scale?: Partial<Project['scale']> } = {}): OpenProject {
  const paths = pathsFor(resolve(root));
  const base = defaultProject();
  const project = parseProject({ ...base, ...overrides, scale: { ...base.scale, ...overrides.scale } });
  for (const d of [paths.dir, paths.patches, paths.sets, paths.sessions, paths.taste, paths.renders]) mkdirSync(d, { recursive: true });
  if (!existsSync(paths.projectFile)) writeFileSync(paths.projectFile, JSON.stringify(project, null, 2) + '\n');
  if (!existsSync(paths.kit)) writeFileSync(paths.kit, JSON.stringify({ schema: 'beeps/kit@1', sounds: [] }, null, 2) + '\n');
  const ignore = join(paths.dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, 'renders/\ncache/\n');
  return openProject(paths.root);
}

export function parseOrThrow(input: unknown, where: string): Patch {
  const r = parsePatch(input);
  if (r.ok) return r.patch;
  const first = r.issues[0];
  throw new BeepsError('E_SCHEMA', `${where}: ${first.message}${r.issues.length > 1 ? ` (+${r.issues.length - 1} more)` : ''}`, { pointer: first.pointer, hint: first.hint });
}

export function readJsonFile(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    throw new BeepsError('E_NOT_FOUND', `cannot read JSON ${path}: ${(e as Error).message}`);
  }
}

/** A patch by project name, a candidate name inside a set, or a path to a .json file. */
export function loadPatch(p: OpenProject, ref: string): Patch {
  if (ref.endsWith('.json') && existsSync(ref)) return parseOrThrow(readJsonFile(ref), ref);
  const own = join(p.paths.patches, `${ref}.json`);
  if (existsSync(own)) return parseOrThrow(readJsonFile(own), own);
  if (existsSync(p.paths.sets)) {
    for (const set of readdirSync(p.paths.sets)) {
      const cand = join(p.paths.sets, set, 'candidates', `${ref}.json`);
      if (existsSync(cand)) return parseOrThrow(readJsonFile(cand), cand);
    }
  }
  throw new BeepsError('E_NOT_FOUND', `no patch "${ref}"`, { hint: 'use a name from "beeps list", a set candidate name, or a path to a .json patch' });
}

export function savePatch(p: OpenProject, patch: Patch, { force = false } = {}): string {
  const file = join(p.paths.patches, `${patch.name}.json`);
  if (existsSync(file) && !force) throw new BeepsError('E_CONFLICT', `patch "${patch.name}" already exists`, { hint: 'pass --force to replace it' });
  mkdirSync(p.paths.patches, { recursive: true });
  writeFileSync(file, JSON.stringify(patch, null, 2) + '\n');
  return file;
}

export function listPatches(p: OpenProject): Patch[] {
  if (!existsSync(p.paths.patches)) return [];
  return readdirSync(p.paths.patches).filter(f => f.endsWith('.json')).sort()
    .map(f => parseOrThrow(readJsonFile(join(p.paths.patches, f)), f));
}
