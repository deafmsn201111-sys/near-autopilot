import { describe, expect, it } from 'vitest';
import { accountId } from '@near-autopilot/core';
import type { TestnetChainReader } from '../src/testnet-tx/chain';
import { YOCTO_PER_NEAR } from '../src/testnet-tx/model';
import {
  BURROW_TESTNET,
  OperationRefused,
  planOperation,
  WRAP_TESTNET,
} from '../src/testnet-tx/operations';

const ME = accountId('sergetest.testnet');
const N = YOCTO_PER_NEAR;

/** Mock chain: wrap.testnet and the Burrow testnet contract, read-only views only. */
class Fake implements TestnetChainReader {
  burrowRegistered = true;
  wnear = N / 20n; // 0.05
  supplied = 0n;
  async status() {
    return { chainId: 'testnet', blockHeight: 1 };
  }
  async account() {
    return { amount: 15n * N, locked: 0n, storageUsage: 182n };
  }
  async accessKey() {
    return null;
  }
  async view(c: string, m: string) {
    if (c === BURROW_TESTNET) {
      if (m === 'storage_balance_of')
        return this.burrowRegistered ? { total: '1', available: '0' } : null;
      if (m === 'storage_balance_bounds') return { min: (N / 10n).toString(), max: null };
      if (m === 'get_asset') return { config: { can_deposit: true, extra_decimals: 0 } };
      if (m === 'get_account')
        return this.burrowRegistered
          ? {
              supplied: this.supplied
                ? [{ token_id: WRAP_TESTNET, balance: this.supplied.toString() }]
                : [],
            }
          : null;
    }
    if (c === WRAP_TESTNET && m === 'ft_balance_of') return this.wnear.toString();
    throw new Error(`unexpected view ${c}.${m}`);
  }
  async exports() {
    return ['get_account', 'get_asset', 'storage_balance_of', 'ft_on_transfer'];
  }
  async gasPrice() {
    return 100_000_000n;
  }
  async txOutcome() {
    return { kind: 'not_found' } as const;
  }
}

describe('testnet: deposit wNEAR into Burrow (burrow.supply_wnear)', () => {
  it('builds exactly the supply the agent builds: ft_transfer_call to Burrow, empty message, 1 yocto', async () => {
    const chain = new Fake();
    const op = await planOperation('burrow.supply_wnear', ME, chain, { amountYocto: N / 100n });
    expect(op.receiverId).toBe(WRAP_TESTNET);
    expect(op.methodName).toBe('ft_transfer_call');
    expect(op.args).toEqual({
      receiver_id: BURROW_TESTNET,
      amount: (N / 100n).toString(),
      msg: '',
    });
    expect(op.depositYocto).toBe(1n);
    chain.supplied = N / 100n;
    expect(await op.verify(chain)).toMatch(/increased by 0\.01/);
  });

  it('refuses when the account is not registered with Burrow: the 0.1 NEAR storage deposit exceeds the per-operation limit', async () => {
    const chain = new Fake();
    chain.burrowRegistered = false;
    await expect(
      planOperation('burrow.supply_wnear', ME, chain, { amountYocto: N / 100n }),
    ).rejects.toThrow(/not registered with .*per-operation limit/);
  });

  it('refuses more wNEAR than held, and amounts outside 0.001-0.05', async () => {
    const chain = new Fake();
    chain.wnear = N / 1000n;
    await expect(
      planOperation('burrow.supply_wnear', ME, chain, { amountYocto: N / 100n }),
    ).rejects.toThrow(OperationRefused);
    await expect(
      planOperation('burrow.supply_wnear', ME, new Fake(), { amountYocto: N / 10n }),
    ).rejects.toThrow(/between/);
  });
});
