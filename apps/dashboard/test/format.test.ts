import { describe, expect, it } from 'vitest';
import { formatAmount, formatHealthFactor, formatUsd, statusTone } from '../lib/format';

describe('format', () => {
  it('formats USD strings', () => {
    expect(formatUsd('1234567.5')).toBe('$1,234,567.50');
    expect(formatUsd('0.05')).toBe('$0.05');
    expect(formatUsd('-12.30')).toBe('-$12.30');
    expect(formatUsd(null)).toBe('unpriced');
  });

  it('formats raw token amounts by decimals', () => {
    expect(formatAmount('1500000000000000000000000', 24)).toBe('1.5');
    expect(formatAmount('42', 6)).toBe('0');
    expect(formatAmount('42000', 6)).toBe('0.042');
    expect(formatAmount('1234567890', 6)).toBe('1,234.5678');
    expect(formatAmount('7', 0)).toBe('7');
  });

  it('formats health factor', () => {
    expect(formatHealthFactor(null)).toBe('No debt');
    expect(formatHealthFactor(1.5749)).toBe('1.57');
  });

  it('maps statuses to tones', () => {
    expect(statusTone('executed')).toBe('good');
    expect(statusTone('rejected')).toBe('bad');
    expect(statusTone('dry_run')).toBe('neutral');
  });
});

describe('provenance labels never confuse simulated, testnet, mainnet and on-chain', () => {
  it('banner', async () => {
    const { provenanceBanner } = await import('../lib/format');
    expect(
      provenanceBanner({ dataSource: 'simulation', network: 'testnet', executionMode: 'dry-run' }),
    ).toMatchObject({ tone: 'sim' });
    expect(
      provenanceBanner({ dataSource: 'simulation', network: 'testnet', executionMode: 'dry-run' })
        .text,
    ).toContain('no result here happened on-chain');
    expect(
      provenanceBanner({ dataSource: 'chain', network: 'testnet', executionMode: 'dry-run' }).text,
    ).toMatch(/^TESTNET · READ-ONLY · DRY-RUN: real NEAR testnet data/);
    expect(
      provenanceBanner({ dataSource: 'chain', network: 'testnet', executionMode: 'dry-run' }).text,
    ).toContain('Nothing is signed or sent');
    expect(
      provenanceBanner({ dataSource: 'chain', network: 'mainnet', executionMode: 'dry-run' }).text,
    ).toMatch(/^MAINNET data, read-only/);
    const ref = provenanceBanner({
      dataSource: 'chain',
      network: 'testnet',
      executionMode: 'dry-run',
      marketData: 'mainnet-reference',
    }).text;
    expect(ref).toMatch(/^TESTNET EXECUTION · MAINNET MARKET DATA · NO MAINNET TRANSACTIONS/);
    expect(ref).toContain('not the value of the test tokens');
    expect(ref).toContain('nothing is signed or sent');
  });

  it('evidence', async () => {
    const { evidenceLabel } = await import('../lib/format');
    const base = { dataSource: 'chain', network: 'testnet' } as const;
    // A simulation row is "simulated" even if something put a hash on it.
    expect(
      evidenceLabel({
        dataSource: 'simulation',
        network: 'testnet',
        status: 'executed',
        executionMode: 'live',
        txHash: 'X',
      }),
    ).toBe('Simulated: mock data, not sent');
    expect(evidenceLabel({ ...base, status: 'executed', executionMode: 'live', txHash: 'H' })).toBe(
      'On-chain (testnet): transaction H confirmed',
    );
    expect(
      evidenceLabel({ ...base, status: 'failed', executionMode: 'live', txHash: 'H' }),
    ).toContain('outcome not confirmed');
    expect(
      evidenceLabel({ ...base, status: 'dry_run', executionMode: 'dry-run', txHash: null }),
    ).toBe('Dry run on testnet data: not sent');
    expect(evidenceLabel({ ...base, status: 'rejected', executionMode: null, txHash: null })).toBe(
      'Not executed (testnet data)',
    );
  });
});

describe('formatFractionPercent (exact, truncated)', () => {
  it('formats fractions from the API as percentages without float rounding', async () => {
    const { formatFractionPercent } = await import('../lib/format');
    expect(formatFractionPercent('0.104335039813366256446294778')).toBe('10.43 %');
    expect(formatFractionPercent('2.497000482062869906959227371')).toBe('249.70 %');
    expect(formatFractionPercent('0.000000015502412932919529923')).toBe('0.00 %');
    expect(formatFractionPercent('0')).toBe('0.00 %');
    expect(formatFractionPercent('1')).toBe('100.00 %');
    expect(formatFractionPercent('0.0438')).toBe('4.38 %');
    expect(formatFractionPercent(null)).toBe('—');
  });
});
