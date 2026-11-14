import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openAnalysis, sealAnalysis } from '../src/analytics/analysis-store';

const KEY = randomBytes(32);
const PAYLOAD = { note: 'move 12 NEAR to Burrow', recommendations: [{ id: 'a' }] };

describe('saved analysis encryption', () => {
  it('round-trips under the same key and binding', () => {
    const sealed = sealAnalysis(KEY, 'alice.near/balanced', PAYLOAD);
    expect(openAnalysis(KEY, 'alice.near/balanced', sealed)).toEqual(PAYLOAD);
  });

  it('stores no plaintext', () => {
    const sealed = sealAnalysis(KEY, 'alice.near/balanced', PAYLOAD);
    expect(Object.keys(sealed).sort()).toEqual(['ct', 'iv', 'tag', 'v']);
    expect(JSON.stringify(sealed)).not.toContain('Burrow');
  });

  it('uses a fresh IV per write', () => {
    const a = sealAnalysis(KEY, 'x', PAYLOAD);
    const b = sealAnalysis(KEY, 'x', PAYLOAD);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('reads as none with another key, another binding, a tampered or a plaintext row', () => {
    const sealed = sealAnalysis(KEY, 'alice.near/balanced', PAYLOAD);
    expect(openAnalysis(randomBytes(32), 'alice.near/balanced', sealed)).toBeNull();
    expect(openAnalysis(KEY, 'bob.near/balanced', sealed)).toBeNull();
    const flipped = Buffer.from(sealed.ct, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(
      openAnalysis(KEY, 'alice.near/balanced', { ...sealed, ct: flipped.toString('base64') }),
    ).toBeNull();
    const shortTag = Buffer.from(sealed.tag, 'base64').subarray(0, 4).toString('base64');
    expect(openAnalysis(KEY, 'alice.near/balanced', { ...sealed, tag: shortTag })).toBeNull();
    expect(openAnalysis(KEY, 'alice.near/balanced', PAYLOAD)).toBeNull();
    expect(openAnalysis(KEY, 'alice.near/balanced', null)).toBeNull();
  });
});
