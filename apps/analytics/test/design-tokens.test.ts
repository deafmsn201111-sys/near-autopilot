import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const css = readFileSync(join(root, 'app/globals.css'), 'utf8');
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/gi;
const TOKEN_BLOCKS = /^:root(?:\[data-theme='light'\])? \{[^}]*\}/gm;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('design tokens', () => {
  it('defines the dark theme on :root and the light theme on [data-theme=light]', () => {
    const blocks = css.match(TOKEN_BLOCKS) ?? [];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('color-scheme: dark');
    expect(blocks[1]).toContain('color-scheme: light');
    expect(css).not.toContain("[data-theme='dark']");
  });

  it('keeps every colour literal inside the token blocks', () => {
    expect(css.replace(TOKEN_BLOCKS, '').match(COLOUR) ?? []).toEqual([]);
  });

  it('keeps colour literals out of components (theme-color meta excepted)', () => {
    const offenders = ['app', 'components', 'lib']
      .flatMap((dir) => sourceFiles(join(root, dir)))
      .filter((file) => !file.endsWith(join('lib', 'theme.ts')))
      .filter((file) => /#[0-9a-f]{6}\b/i.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('focuses with the accent outline, not box-shadow rings', () => {
    expect(css).toMatch(
      /:focus-visible \{\s*outline: 2px solid var\(--accent\);\s*outline-offset: 2px;/,
    );
  });

  it('never asks the font for a weight above 600', () => {
    expect(css).not.toMatch(/font-weight: (?:650|700|800|900|bold)/);
  });
});
