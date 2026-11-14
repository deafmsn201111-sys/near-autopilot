import { describe, expect, it } from 'vitest';
import { aiFailure, bridgeOpenError, plainReadError, staleNotices } from '../lib/plain-error';

describe('a failed read in plain words', () => {
  it('a rate limit is about our load, never the account name', () => {
    const e = plainReadError(429, 'Too many requests right now. Wait a few minutes and try again.');
    expect(e.blamesInput).toBe(false);
    expect(e.text).toMatch(/a lot of reads/i);
  });

  it('our server down says so without the raw error', () => {
    const e = plainReadError(0, 'the analytics service is unreachable');
    expect(e.text).not.toContain('analytics service');
    expect(e.text).toMatch(/not answering/i);
  });

  it('NEAR not answering is NEAR, not the visitor', () => {
    expect(plainReadError(502, 'could not read the account from NEAR right now').text).toMatch(
      /NEAR did not answer/,
    );
  });

  it('a missing account keeps its own sentence and asks to check the name', () => {
    const e = plainReadError(404, 'account nobody.near does not exist on NEAR mainnet');
    expect(e.blamesInput).toBe(true);
    expect(e.text).toContain('nobody.near does not exist');
  });

  it('anything else is our failure, in plain words', () => {
    expect(plainReadError(500, 'the analytics service failed (HTTP 500)').text).not.toMatch(/HTTP/);
  });
});

describe('a failed AI run in plain words', () => {
  it('names a timeout, a busy model and an unreachable server apart', () => {
    expect(aiFailure({ status: 429 })?.title).toBe('The AI is busy right now.');
    expect(aiFailure({ fallback: 'busy' })?.title).toBe('The AI is busy right now.');
    expect(aiFailure({ fallback: 'deadline' })?.title).toBe('The AI took too long.');
    expect(aiFailure({ status: 504 })?.title).toBe('The AI took too long.');
    expect(aiFailure({ status: 0 })?.title).toBe('The AI could not be reached.');
    expect(aiFailure({ status: 502 })?.title).toBe('The AI could not be reached.');
    expect(aiFailure({ fallback: 'model_error' })?.title).toBe('The AI run failed.');
    expect(aiFailure({})?.title).toBe('The AI run failed.');
  });

  it('always says the rule-based result is what is shown', () => {
    expect(aiFailure({ status: 429 })?.detail).toMatch(/rule-based result/);
  });

  it('a daily budget is a pause, not a failure to retry now', () => {
    expect(aiFailure({ fallback: 'cap' })).toMatchObject({
      title: 'AI analysis is paused for today.',
      retry: false,
    });
  });

  it('is null when the run did not fail', () => {
    expect(aiFailure({ fallback: 'off' })).toBeNull();
    expect(aiFailure({ fallback: 'nothing_to_rank' })).toBeNull();
    expect(aiFailure({ fallback: 'not_owner' })).toBeNull();
  });
});

describe('stale-data notices', () => {
  const now = '2026-11-14T10:20:00.000Z';
  const prices = { dataAsOf: '2026-11-14T10:18:00.000Z', intervalSeconds: 300, now };

  it('a failed read over an older one gives its time, age and the plain reason', () => {
    const [n] = staleNotices({
      read: { stale: true, asOf: '2026-11-14T10:14:00.000Z', status: 0, error: 'x' },
      prices,
      now,
    });
    expect(n?.title).toBe("Couldn't refresh.");
    expect(n?.detail).toMatch(
      /^Showing data from 10:14 UTC \(6 min ago\)\. Our server is not answering/,
    );
  });

  it('prices older than three collector cycles get their own notice', () => {
    const old = { ...prices, dataAsOf: '2026-11-14T10:04:00.000Z' };
    const out = staleNotices({
      read: { stale: false, asOf: now, status: null, error: null },
      prices: old,
      now,
    });
    expect(out).toEqual([
      {
        title: 'Prices may be out of date.',
        detail:
          'The price feed last updated at 10:04 UTC (16 min ago); the values below use those prices.',
      },
    ]);
  });

  it('one missed cycle is not a warning, and fresh data says nothing', () => {
    const late = { ...prices, dataAsOf: '2026-11-14T10:07:00.000Z' };
    expect(
      staleNotices({
        read: { stale: false, asOf: now, status: null, error: null },
        prices: late,
        now,
      }),
    ).toEqual([]);
    expect(
      staleNotices({
        read: { stale: false, asOf: now, status: null, error: null },
        prices: null,
        now,
      }),
    ).toEqual([]);
  });
});

describe('Add funds that could not open HOT', () => {
  it('a rate limit says HOT is busy; anything else says it did not load', () => {
    expect(bridgeOpenError(new Error('HTTP 429'))).toMatch(/busy/);
    expect(bridgeOpenError(new Error('Failed to fetch dynamically imported module'))).toMatch(
      /did not load/,
    );
  });
});
