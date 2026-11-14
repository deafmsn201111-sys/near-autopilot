import { describe, expect, it } from 'vitest';
import { MAX_TOKEN_ICON_LENGTH, safeTokenIcon } from '../src/token-icon';

describe('safeTokenIcon', () => {
  it('keeps image data URIs as the token contract stores them', () => {
    const svg = "data:image/svg+xml,%3Csvg width='96' height='96'%3E%3C/svg%3E";
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(safeTokenIcon(svg)).toBe(svg);
    expect(safeTokenIcon(png)).toBe(png);
    expect(safeTokenIcon('data:image/svg+xml;base64,PHN2Zy8+')).toBe(
      'data:image/svg+xml;base64,PHN2Zy8+',
    );
  });

  it('keeps the other shapes real contracts use: utf8, raw quotes, image/jpg', () => {
    for (const ok of [
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'data:image/svg+xml;charset=utf-8,%3Csvg%3E',
      'data:image/jpg;base64,/9j/4AAQ',
    ])
      expect(safeTokenIcon(ok), ok).toBe(ok);
  });

  it('refuses anything that is not an image data URI', () => {
    for (const bad of [
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)',
      'https://evil.example/logo.png',
      'data:image/svg+xml',
      'data:application/xml,<svg/>',
      ' data:image/png;base64,AAAA',
      '<svg onload="alert(1)"></svg>',
      'data:image/png;base64,AAAA"><script>',
      '',
    ])
      expect(safeTokenIcon(bad), bad).toBeNull();
  });

  it('refuses an oversize icon', () => {
    const big = `data:image/png;base64,${'A'.repeat(MAX_TOKEN_ICON_LENGTH)}`;
    expect(safeTokenIcon(big)).toBeNull();
  });

  it('refuses non-strings', () => {
    expect(safeTokenIcon(null)).toBeNull();
    expect(safeTokenIcon(undefined)).toBeNull();
    expect(safeTokenIcon(42)).toBeNull();
  });
});
