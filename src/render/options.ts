// The options every render entry point takes from an open project: where its renders are cached and where its sample objects live.
import type { OpenProject } from '../project.ts';
import { samplePaths } from '../samples/store.ts';
import type { Project } from '../schema/project.ts';

export interface RenderOptions { project: Project; rendersDir: string; sampleObjectsDir?: string }

/** The options for renderAndMeasure: the project, its render cache and its sample object store, plus any `extra`. */
export function renderOptions<X extends object = {}>(p: OpenProject, extra?: X): { project: Project; rendersDir: string; sampleObjectsDir: string } & X {
  return { project: p.project, rendersDir: p.paths.renders, sampleObjectsDir: samplePaths(p).objects, ...extra } as ReturnType<typeof renderOptions<X>>;
}

/** The options for renderSong and renderLayers: the project and its render cache (songs read no sample objects), plus any `extra`. */
export function songRenderOptions<X extends object = {}>(p: OpenProject, extra?: X): { project: Project; rendersDir: string } & X {
  return { project: p.project, rendersDir: p.paths.renders, ...extra } as ReturnType<typeof songRenderOptions<X>>;
}
