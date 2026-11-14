import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REFRESH_CAP,
  dueQuotes,
  type DepositDeps,
  type StoredDepositQuote,
  type UnfinishedQuote,
} from '../src/analytics/deposit';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';
import type { SwapStatusReport } from '../src/gateway/one-click-deposit';

const MIN = 60_000;
const NOW = new Date('2026-11-13T10:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const row = (id: string, createdAgo: number, checkedAgo: number | null): UnfinishedQuote => ({
  id,
  createdAt: ago(createdAgo),
  statusAt: checkedAgo === null ? null : ago(checkedAgo),
});

describe('dueQuotes', () => {
  it('checks a fresh quote every minute and an old one at most every 10 minutes', () => {
    const rows = [
      row('fresh-due', 2 * MIN, MIN),
      row('fresh-not-due', 2 * MIN, 30_000),
      row('hour-old-not-due', 60 * MIN, 9 * MIN),
      row('hour-old-due', 60 * MIN, 10 * MIN),
      row('mid-age-not-due', 20 * MIN, 3 * MIN),
      row('mid-age-due', 20 * MIN, 4 * MIN),
    ];
    expect(dueQuotes(rows, NOW).sort()).toEqual(['fresh-due', 'hour-old-due', 'mid-age-due']);
  });

  it('counts a check stored a moment after the last run started as a minute ago', () => {
    expect(dueQuotes([row('jitter', 2 * MIN, MIN - 50)], NOW)).toEqual(['jitter']);
  });

  it('takes never-checked first, then the longest unchecked, at most the cap', () => {
    const rows = Array.from({ length: REFRESH_CAP + 5 }, (_, i) =>
      row(`q${i}`, 60 * MIN, 10 * MIN + i * 1000),
    );
    rows.push(row('never', 60 * MIN, null));
    const due = dueQuotes(rows, NOW);
    expect(due).toHaveLength(REFRESH_CAP);
    expect(due[0]).toBe('never');
    expect(due[1]).toBe(`q${REFRESH_CAP + 4}`);
  });
});

const stored = (id: string): StoredDepositQuote => ({
  id,
  createdAt: ago(2 * MIN),
  accountId: 'alice.near',
  originAsset: 'nep141:eth-0xa0b8.omft.near',
  destinationAsset: 'nep141:wrap.near',
  amountIn: '100000000',
  amountOut: '99750000',
  minAmountOut: '98752500',
  refundTo: '0x2527d02599ba641c19fea793cd0f167589a0f10d',
  depositAddress: `addr-${id}`,
  deadline: new Date(NOW.getTime() + 10 * MIN),
  correlationId: 'c0ffee',
  signature: 'ed25519:sig',
  feeBps: 1,
});

const pending: SwapStatusReport = {
  status: 'PENDING_DEPOSIT',
  depositedAmount: null,
  amountOut: null,
  refundedAmount: null,
  refundReason: null,
  nearTxHash: null,
};

describe('background refresh of unfinished deposits', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  function setup(
    answer: () => Promise<SwapStatusReport> = async () => pending,
    refresh = true,
    rows = [row('a', 2 * MIN, null), row('b', 2 * MIN, null)],
  ) {
    let clock = NOW;
    const asked: string[] = [];
    const saved: { id: string; at: Date }[] = [];
    const sinces: Date[] = [];
    const deposit: DepositDeps = {
      oneClick: {
        tokens: async () => [],
        quote: async () => {
          throw new Error('not used');
        },
        status: async (address) => {
          asked.push(address);
          return answer();
        },
      },
      store: {
        save: async () => undefined,
        purge: async () => undefined,
        find: async (id) => ({ ...stored(id), status: 'PENDING_DEPOSIT' }),
        issueTransfer: async () => true,
        saveStatus: async (id, _status, at) => {
          saved.push({ id, at });
        },
        unfinished: async (since) => {
          sinces.push(since);
          return rows;
        },
      },
      destinationTokens: [],
      ...(refresh ? { refreshEveryMs: MIN } : {}),
    };
    const app = buildAnalyticsServer({
      apiToken: 'public-token-public-token-public-token-1',
      store: {} as CollectorStore,
      intervalSeconds: 900,
      now: () => clock,
      deposit,
    });
    const tick = async () => {
      clock = new Date(clock.getTime() + MIN);
      await vi.advanceTimersByTimeAsync(MIN);
    };
    return { app, asked, saved, sinces, tick };
  }

  it('asks 1Click about each due quote every minute and stores the check time', async () => {
    const { app, asked, saved, sinces, tick } = setup();
    await app.ready();
    expect(asked).toEqual([]);
    await tick();
    expect(asked).toEqual(['addr-a', 'addr-b']);
    expect(saved.map((s) => s.at)).toEqual([ago(-MIN), ago(-MIN)]);
    expect(sinces).toEqual([new Date(NOW.getTime() + MIN - 30 * MIN)]);
    await app.close();
    await tick();
    expect(asked).toHaveLength(2);
  });

  it('skips a quote 1Click fails on, checks the rest, and keeps serving', async () => {
    let fail = true;
    const { app, asked, tick } = setup(async () => {
      if (fail) throw new Error('upstream down');
      return pending;
    });
    await app.ready();
    await tick();
    expect(asked).toEqual(['addr-a', 'addr-b']);
    fail = false;
    await tick();
    expect(asked).toEqual(['addr-a', 'addr-b', 'addr-a', 'addr-b']);
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('backs off a quote that keeps failing like a checked one', async () => {
    const { app, asked, tick } = setup(
      async () => {
        throw new Error('upstream down');
      },
      true,
      [row('old', 60 * MIN, null)],
    );
    await app.ready();
    await tick();
    for (let i = 0; i < 9; i++) await tick();
    expect(asked).toEqual(['addr-old']);
    await tick();
    expect(asked).toEqual(['addr-old', 'addr-old']);
    await app.close();
  });

  it('does not start without the setting', async () => {
    const { app, asked, tick } = setup(undefined, false);
    await app.ready();
    await tick();
    expect(asked).toEqual([]);
    await app.close();
  });
});
