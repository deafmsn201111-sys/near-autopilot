import { randomBytes } from 'node:crypto';
import {
  createDatabase,
  depositQuotes,
  runMigrations,
  sql,
  type DatabaseHandle,
} from '@near-autopilot/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoredDepositQuote } from '../src/analytics/deposit';
import { DrizzleDepositQuoteStore } from '../src/analytics/deposit-store';

/** The 1Click deposit quote store on a real PostgreSQL (skipped unless DATABASE_TEST_URL is set; CI sets it). */
const adminUrl = process.env['DATABASE_TEST_URL'];
const NOW = new Date('2026-11-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const quote = (id: string, createdAt: Date): StoredDepositQuote => ({
  id,
  createdAt,
  accountId: 'alice.near',
  originAsset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  amountIn: '100000000',
  amountOut: '99750000',
  minAmountOut: '98750000',
  refundTo: '0x2527d02599ba641c19fea793cd0f167589a0f10d',
  depositAddress: '0x76b4c56085ed136a8744d52be956396624a730e8',
  deadline: new Date(createdAt.getTime() + 10 * 60_000),
  correlationId: 'c0ffee',
  signature: 'ed25519:sig',
  feeBps: 25,
});

describe.skipIf(!adminUrl)('DrizzleDepositQuoteStore (PostgreSQL)', () => {
  const dbName = `autopilot_deposit_${randomBytes(6).toString('hex')}`;
  let admin: DatabaseHandle;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    admin = createDatabase(adminUrl ?? '', { max: 1 });
    await admin.db.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
    const url = new URL(adminUrl ?? '');
    url.pathname = `/${dbName}`;
    handle = createDatabase(url.toString(), { max: 2 });
    await runMigrations(handle.db);
  });

  afterAll(async () => {
    await handle.close();
    await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}"`));
    await admin.close();
  });

  beforeEach(async () => {
    await handle.db.delete(depositQuotes);
  });

  it('stores a quote as given', async () => {
    const store = new DrizzleDepositQuoteStore(handle.db, () => NOW);
    await store.save(quote('dq_1', NOW));
    expect(await handle.db.select().from(depositQuotes)).toEqual([quote('dq_1', NOW)]);
  });

  it('refuses a duplicate id and a non-integer amount', async () => {
    const store = new DrizzleDepositQuoteStore(handle.db, () => NOW);
    await store.save(quote('dq_1', NOW));
    await expect(store.save(quote('dq_1', NOW))).rejects.toThrow();
    await expect(store.save({ ...quote('dq_2', NOW), amountIn: '1.5' })).rejects.toThrow();
  });

  it('purges quotes older than 30 days only', async () => {
    const store = new DrizzleDepositQuoteStore(handle.db, () => NOW);
    await store.save(quote('old', new Date(NOW.getTime() - 30 * DAY - 1)));
    await store.save(quote('edge', new Date(NOW.getTime() - 30 * DAY)));
    await store.save(quote('new', NOW));
    await store.purge();
    const ids = (await handle.db.select({ id: depositQuotes.id }).from(depositQuotes)).map(
      (r) => r.id,
    );
    expect(ids.sort()).toEqual(['edge', 'new']);
  });
});
