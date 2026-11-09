import { describe, expect, it } from 'vitest';
import { accountId } from '@near-autopilot/core';
import { buildUnwrapNear, buildWrapNear, WRAP_GAS } from '../src/wallet/wrap';

const WRAP = accountId('wrap.near');

describe('buildUnwrapNear', () => {
  it('calls near_withdraw with the amount and one yoctoNEAR', () => {
    const tx = buildUnwrapNear({
      wrapContractId: WRAP,
      rawAmount: 1_272_358_000_000_000_000_000_000n,
    });
    expect(tx.receiverId).toBe(WRAP);
    const a = tx.actions[0]!;
    expect(a.methodName).toBe('near_withdraw');
    expect(a.args).toEqual({ amount: '1272358000000000000000000' });
    expect(a.deposit).toBe(1n);
    expect(a.gas).toBe(WRAP_GAS);
  });
  it('rejects a non-positive amount', () => {
    expect(() => buildUnwrapNear({ wrapContractId: WRAP, rawAmount: 0n })).toThrow(RangeError);
  });
});

describe('buildWrapNear', () => {
  it('attaches the native NEAR as the near_deposit deposit', () => {
    const tx = buildWrapNear({
      wrapContractId: WRAP,
      rawAmount: 5_000_000_000_000_000_000_000_000n,
    });
    const a = tx.actions[0]!;
    expect(a.methodName).toBe('near_deposit');
    expect(a.args).toEqual({});
    expect(a.deposit).toBe(5_000_000_000_000_000_000_000_000n);
  });
  it('rejects a non-positive amount', () => {
    expect(() => buildWrapNear({ wrapContractId: WRAP, rawAmount: 0n })).toThrow(RangeError);
  });
});
