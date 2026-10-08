// Patch families: one template patch + a table of rows -> N validated patches. Pure and deterministic.
import { z } from 'zod';
import { BeepsError } from './errors.ts';
import { sha256 } from './hash.ts';
import { getPointer, parsePointer, setPointer } from './pointer.ts';
import { parsePatch, type Patch } from './schema/patch.ts';

export type Row = Record<string, unknown>;

const RANGE = /^\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const WHOLE = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/;

/** A deterministic uniform [0,1) for (seed, row, key): adding or reordering other rows never shifts it. */
export function unit(seed: number, rowKey: string, key: string): number {
  return parseInt(sha256(`${seed}|${rowKey}|${key}`).slice(0, 12), 16) / 2 ** 48;
}
const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** A table cell from CSV or --row text: numbers, booleans, JSON objects/arrays, else the string. */
export function parseCell(raw: string): unknown {
  const s = raw.trim();
  if (s === '') return '';
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^[[{"]/.test(s)) { try { return JSON.parse(s); } catch { /* a plain string */ } }
  return s;
}

export function parseCsv(text: string): Row[] {
  const lines: string[][] = [];
  let cur: string[] = [], field = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { cur.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      cur.push(field); field = ''; lines.push(cur); cur = [];
    } else field += c;
  }
  if (field !== '' || cur.length) { cur.push(field); lines.push(cur); }
  const rows = lines.filter(l => l.some(f => f.trim() !== ''));
  if (rows.length < 2) throw new BeepsError('E_USAGE', 'a CSV table needs a header row and at least one data row');
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map((r, i) => {
    if (r.length > header.length) throw new BeepsError('E_USAGE', `CSV row ${i + 1} has ${r.length} cells but the header has ${header.length}`);
    return Object.fromEntries(header.map((h, j) => [h, parseCell(r[j] ?? '')]));
  });
}

/** `--row "name=a,/layers/0/source/pitch=220"` -> one row. Use a table file for values that contain commas. */
export function parseInlineRow(text: string): Row {
  const row: Row = {};
  for (const part of text.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 1) throw new BeepsError('E_USAGE', `bad --row "${text}": expected key=value pairs separated by commas`);
    row[part.slice(0, eq).trim()] = parseCell(part.slice(eq + 1));
  }
  return row;
}

export function parseTable(text: string, fileName: string): Row[] {
  if (/\.csv$/i.test(fileName)) return parseCsv(text);
  let json: unknown;
  try { json = JSON.parse(text); } catch (e) { throw new BeepsError('E_USAGE', `${fileName}: not valid JSON (${(e as Error).message}); use .json or .csv`); }
  const r = z.array(z.record(z.string(), z.unknown())).min(1).safeParse(json);
  if (!r.success) throw new BeepsError('E_USAGE', `${fileName}: a JSON table is a non-empty array of row objects`);
  return r.data;
}

export interface FamilyOptions {
  seed?: number;
  /** pointer -> relative amount: the numeric value at that pointer is scaled by 1 +/- amount. */
  jitter?: Record<string, number>;
}
export interface RowFailure { row: number; name: string | null; message: string; pointer?: string; hint?: string }
export interface FamilyResult { patches: Patch[]; unusedParams: string[] }

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const esc = (k: string) => k.replaceAll('~', '~0').replaceAll('/', '~1');

/** Replace {{param}} in every string; a string that is only a placeholder takes the param's own type. */
function substitute(node: unknown, params: Row, path: string, missing: (name: string, at: string) => void, used: Set<string>): unknown {
  if (typeof node === 'string') {
    const whole = node.match(WHOLE);
    if (whole) {
      used.add(whole[1]);
      if (!(whole[1] in params)) { missing(whole[1], path); return node; }
      return params[whole[1]];
    }
    return node.replace(PLACEHOLDER, (m, k: string) => {
      used.add(k);
      if (!(k in params)) { missing(k, path); return m; }
      return String(params[k]);
    });
  }
  if (Array.isArray(node)) return node.map((x, i) => substitute(x, params, `${path}/${i}`, missing, used));
  if (isPlain(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, params, `${path}/${esc(k)}`, missing, used)]));
  return node;
}

export function buildFamily(template: unknown, rows: Row[], opts: FamilyOptions = {}): FamilyResult {
  if (!isPlain(template)) throw new BeepsError('E_SCHEMA', 'the template must be a JSON object (a patch with optional {{param}} placeholders)', { pointer: '' });
  for (const k of Object.keys(opts.jitter ?? {})) {
    try { parsePointer(k); } catch (e) { throw new BeepsError('E_USAGE', (e as Error).message); }
  }
  const seed = opts.seed ?? 1;
  const failures: RowFailure[] = [];
  const patches: Patch[] = [];
  const used = new Set<string>();
  const seenParams = new Set<string>();

  rows.forEach((row, i) => {
    const rowKey = String(row.name ?? i);
    const fail = (message: string, extra: { pointer?: string; hint?: string } = {}) => failures.push({ row: i, name: typeof row.name === 'string' ? row.name : null, message, ...extra });
    // Ranges "a..b" resolve once per (row, key), so a param used twice is the same number.
    const cells: Row = {};
    for (const [k, v] of Object.entries(row)) {
      const m = typeof v === 'string' ? v.match(RANGE) : null;
      cells[k] = m ? round(Number(m[1]) + unit(seed, rowKey, k) * (Number(m[2]) - Number(m[1]))) : v;
    }
    const params: Row = { index: i + 1, count: rows.length, ...cells };
    const overrides = Object.entries(cells).filter(([k]) => k.startsWith('/'));
    for (const k of Object.keys(cells)) if (!k.startsWith('/')) seenParams.add(k);

    let missingHere = false;
    const doc = substitute(structuredClone(template), params, '', (name, at) => { missingHere = true; fail(`no value for {{${name}}} in this row`, { pointer: at, hint: `add a "${name}" column, or remove the placeholder` }); }, used) as Record<string, unknown>;
    if (missingHere) return;
    if (typeof row.name === 'string') doc.name = row.name;
    if (row.family !== undefined) doc.family = row.family;
    if (row.tags !== undefined) {
      const add = Array.isArray(row.tags) ? row.tags.map(String) : String(row.tags).split(/[|\s]+/).filter(Boolean);
      doc.tags = [...new Set([...(Array.isArray(doc.tags) ? doc.tags : []), ...add])];
    }
    for (const [ptr, value] of overrides) {
      try { setPointer(doc, ptr, value); } catch (e) { fail((e as Error).message, { pointer: ptr }); }
    }
    for (const [ptr, amount] of Object.entries(opts.jitter ?? {})) {
      try {
        const cur = getPointer(doc, ptr);
        if (typeof cur !== 'number') { fail('--jitter target is not a number', { pointer: ptr }); continue; }
        setPointer(doc, ptr, round(cur * (1 + (unit(seed, rowKey, `jitter:${ptr}`) * 2 - 1) * amount)));
      } catch (e) { fail((e as Error).message, { pointer: ptr }); }
    }
    if (failures.some(f => f.row === i)) return;
    const r = parsePatch(doc);
    if (!r.ok) { for (const issue of r.issues.slice(0, 3)) fail(issue.message, { pointer: issue.pointer, hint: issue.hint }); return; }
    patches.push(r.patch);
  });

  if (failures.length) {
    const first = failures[0];
    throw new BeepsError('E_SCHEMA', `row ${first.row}${first.name ? ` (${first.name})` : ''}: ${first.message}${failures.length > 1 ? ` (+${failures.length - 1} more failures)` : ''}`, {
      ...(first.pointer !== undefined ? { pointer: first.pointer } : {}),
      ...(first.hint ? { hint: first.hint } : {}),
      details: { rows: failures.slice(0, 25) },
    });
  }
  const names = patches.map(p => p.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new BeepsError('E_USAGE', `patch name "${dup}" appears in more than one row`, { hint: 'give every row a distinct name, or a template name with a {{param}} that differs per row' });
  return { patches, unusedParams: [...seenParams].filter(k => !used.has(k) && !['name', 'family', 'tags'].includes(k)) };
}
