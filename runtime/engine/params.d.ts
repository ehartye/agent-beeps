// Types of params.js (runtime inputs). Hand-written so a consumer that compiles the schema entry (src/schema/patch.ts, TypeScript
// source) finds declarations for the JavaScript it imports instead of an implicit any.
import type { Patch } from '../../src/schema/patch.ts';

export interface RuntimeInput { min: number; max: number; default: number; description?: string }
export interface RuntimeBind {
  input: string;
  target: string | string[];
  range: [number, number];
  shape?: 'linear' | 'quad' | 'sqrt';
  unit?: 'db' | 'lin' | 'oct' | 'st';
  live?: boolean;
  clamp?: [number, number];
}
export interface RuntimeBlock {
  delivery?: 'baked' | 'runtime' | 'both';
  hold?: boolean;
  inputs: Record<string, RuntimeInput>;
  bind: RuntimeBind[];
}
type Kind = 'gain' | 'oct' | 'st' | 'ct' | 'pan';

export const MACROS: Readonly<{ '/out/gainDb': 'db'; '/out/transpose': 'st'; '/out/brightness': 'oct' }>;
export function unitOf(target: string): 'db' | 'st' | 'oct' | 'lin';
export function bd(v: number | undefined, def: number, min: number, max: number, lo: number, hi: number, shape?: 'linear' | 'quad' | 'sqrt'): number;
export function bindDelta(b: RuntimeBind, input: RuntimeInput, v: number | undefined): number;
export function makeLive(inputs: Record<string, RuntimeInput>, vals: Record<string, number>, targets: [AudioParam, Kind, [string, number, number, ('linear' | 'quad' | 'sqrt')?][]][], now: () => number): (input: string, value: number, at?: number, tau?: number) => void;
export function targetsOf(patch: Patch, b: RuntimeBind): string[];
export const LIVE_POINTERS: RegExp[];
export function isLiveTarget(target: string): boolean;
export function defaultParams(patch: Patch): Record<string, number>;
export function clampInput(input: { min: number; max: number }, value: number): number;
export function applyParams(patch: Patch, params?: Record<string, number>, all?: boolean): { patch: Patch; trimDeltaDb: number };
