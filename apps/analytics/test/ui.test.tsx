import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as ui from '../components/ui';
import { Level, Status } from '../components/ui';

const root = join(import.meta.dirname, '..');
const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

describe('Status', () => {
  it('is a risk-toned chip with an icon, the raw code in its tooltip', () => {
    const ok = html(<Status code="OK" />);
    expect(ok).toContain('ds-chip ds-chip-safe');
    expect(ok).toContain('data-tip="OK"');
    expect(ok).toContain('✓');
    expect(html(<Status code="BLOCK" label="never shown" />)).toMatch(
      /ds-chip ds-chip-liq.*never shown/,
    );
    expect(html(<Status code="LOW_CONFIDENCE" />)).toContain('ds-chip-watch');
    expect(html(<Status code="UNPRICED" />)).toContain('ds-chip-act');
  });

  it('stays neutral for an unknown code', () => {
    expect(html(<Status code={null} />)).toMatch(/class="ds-chip"[^>]*data-tip="unknown"/);
  });
});

describe('Level', () => {
  it('words the level on a chip, the score in its tooltip', () => {
    const out = html(<Level level="high" score={82} what="risk" />);
    expect(out).toContain('ds-chip ds-chip-liq');
    expect(out).toContain('High risk');
    expect(out).toContain('data-tip="risk score 82 / 100"');
    expect(html(<Level level="high" score={90} what="confidence" invert />)).toContain(
      'ds-chip-safe',
    );
  });
});

describe('reviewer and secondary pages', () => {
  it('no longer ship the old tile and meter components', () => {
    expect(Object.keys(ui)).not.toContain('Tile');
    expect(Object.keys(ui)).not.toContain('Meter');
  });

  it('build KPIs and chips from the primitives, not the old classes', () => {
    const old = /className="(?:kpis|card tile|chip)"/;
    const offenders = pages(join(root, 'app')).filter((f) => old.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('drop the CSS of the removed components', () => {
    const css = readFileSync(join(root, 'app/globals.css'), 'utf8');
    expect(css).not.toMatch(/(^|[\s,])\.(badge|meter|tile|kpis)\b/m);
  });
});
