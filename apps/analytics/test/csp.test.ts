import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../lib/csp';

const directives = (csp: string) =>
  new Map(
    csp.split(';').map((d) => {
      const [name = '', ...values] = d.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );

describe('content security policy', () => {
  const csp = directives(contentSecurityPolicy('abc123', false));

  it('runs only scripts carrying this response nonce', () => {
    expect(csp.get('script-src')).toEqual(["'nonce-abc123'", "'strict-dynamic'"]);
  });

  it('blocks plugins, base tag hijacks, foreign form posts and framing', () => {
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('allows eval only in development (React refresh)', () => {
    expect(contentSecurityPolicy('n', false)).not.toContain("'unsafe-eval'");
    expect(directives(contentSecurityPolicy('n', true)).get('script-src')).toContain(
      "'unsafe-eval'",
    );
  });
});
