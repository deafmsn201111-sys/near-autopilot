import { describe, expect, it } from 'vitest';
import { earningsSentence } from '../src/analytics/account-view';

describe('earningsSentence', () => {
  it('says a result that rounds to $0.00 breaks even, not that it costs', () => {
    expect(earningsSentence(-0.003, true, [])).not.toMatch(/costs/);
    expect(earningsSentence(-0.003, true, [])).toMatch(/breaks even/);
    expect(earningsSentence(0.004, true, [])).toMatch(/breaks even/);
  });

  it('keeps the earn and cost sentences from a cent up', () => {
    expect(earningsSentence(-0.01, true, [])).toMatch(/costs about \$0\.01 a month/);
    expect(earningsSentence(2.5, true, ['USDt'])).toMatch(/earns about \$2\.50 a month.*USDt/);
  });
});
