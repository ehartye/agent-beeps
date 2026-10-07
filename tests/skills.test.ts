import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const skillsDir = join(root, 'skills');
const skills = readdirSync(skillsDir);

describe('skills', () => {
  it('ships the seven skills', () => {
    expect(skills.sort()).toEqual(['beeps-audition', 'beeps-compose', 'beeps-craft', 'beeps-music', 'beeps-setup', 'beeps-ship', 'beeps-taste']);
  });

  for (const s of skills) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8').replaceAll('\r\n', '\n');
    it(`${s} has frontmatter with name, description and when_to_use, and stays short`, () => {
      const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      expect(fm).toMatch(new RegExp(`^name: ${s}$`, 'm'));
      expect(fm).toMatch(/^description: .{30,}$/m);
      expect(fm).toMatch(/^when_to_use: Use (when|before|after).{20,}$/m);
      expect(text.split('\n').length).toBeLessThanOrEqual(150);
    });
  }
});

describe('the plugin stands alone', () => {
  const files = ['skills', 'craft', 'library', 'src', 'runtime', 'README.md'].flatMap(p => {
    const full = join(root, p);
    try {
      return readdirSync(full, { recursive: true }).map(f => join(full, String(f))).filter(f => /\.(md|json|ts|js|mjs|html)$/.test(f));
    } catch {
      return [full];
    }
  });
  it('has no wikilinks and no references to a local knowledge vault', () => {
    for (const f of files) {
      let text = '';
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      expect(text, f).not.toMatch(/\[\[[A-Za-z][^\][,]*\]\]/); // wikilinks, not JSON tuples like [[from,to]]
      expect(text, f).not.toMatch(/wiki-master|\.wiki-master-vault/);
    }
  });
});
