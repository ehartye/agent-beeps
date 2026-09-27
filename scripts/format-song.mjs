#!/usr/bin/env node
// Formats beeps songs for readable diffs: one line per progression, track, pattern and section.
// Usage: node scripts/format-song.mjs <song.json...>   (rewrites in place; content is unchanged)
import { readFileSync, writeFileSync } from 'node:fs';

const one = v => JSON.stringify(v).replace(/":/g, '": ').replace(/,(?=["{[\d-])/g, ', ');
const GROUPS = new Set(['instruments', 'progressions', 'tracks', 'patterns', 'sections']);

export function formatSong(song) {
  const lines = Object.entries(song).map(([k, v]) => {
    if (GROUPS.has(k) && v && typeof v === 'object' && Object.keys(v).length) {
      const inner = Object.entries(v).map(([n, x]) => `    ${JSON.stringify(n)}: ${one(x)}`).join(',\n');
      return `  ${JSON.stringify(k)}: {\n${inner}\n  }`;
    }
    return `  ${JSON.stringify(k)}: ${one(v)}`;
  });
  return `{\n${lines.join(',\n')}\n}\n`;
}

for (const file of process.argv.slice(2)) {
  const before = JSON.parse(readFileSync(file, 'utf8'));
  const text = formatSong(before);
  if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(before)) throw new Error(`${file}: formatting changed content`);
  writeFileSync(file, text);
}
