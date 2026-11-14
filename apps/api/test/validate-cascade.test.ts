import { describe, expect, it } from 'vitest';
import { accountId, type PlannedTransaction } from '@near-autopilot/core';
import {
  MAX_ACTION_DEPOSIT,
  MAX_ACTION_GAS,
  validateCascade,
} from '../src/wallet/validate-cascade';

const ALICE = accountId('alice.near');
const EX = accountId('v2.ref-finance.near');
const WNEAR = accountId('wrap.near');
const USDT = accountId('usdt.tether-token.near');

const ctx = {
  signerId: ALICE,
  allowedReceivers: new Set<string>([EX, WNEAR, USDT]),
  allowedPools: new Set([3879]),
};

/** A well-formed add_liquidity-style cascade. */
function goodCascade(): PlannedTransaction[] {
  return [
    {
      intentId: 'register',
      signerId: ALICE,
      receiverId: EX,
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'storage_deposit',
          args: { account_id: ALICE, registration_only: true },
          gas: 30_000_000_000_000n,
          deposit: 1_020_000_000_000_000_000_000n,
        },
      ],
    },
    {
      intentId: 'deposit-0',
      signerId: ALICE,
      receiverId: WNEAR,
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'ft_transfer_call',
          args: { receiver_id: EX, amount: '7006497733053073773135110', msg: '' },
          gas: 50_000_000_000_000n,
          deposit: 1n,
        },
      ],
    },
    {
      intentId: 'add-liquidity',
      signerId: ALICE,
      receiverId: EX,
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'add_liquidity',
          args: { pool_id: 3879, amounts: ['7006497733053073773135110', '24776608'] },
          gas: 100_000_000_000_000n,
          deposit: 10_000_000_000_000_000_000_000n,
        },
      ],
    },
  ];
}

/** Replace action 0 of transaction `i` (actions are readonly, so rebuild). */
function patchAction(
  c: PlannedTransaction[],
  i: number,
  patch: Partial<PlannedTransaction['actions'][number]>,
): void {
  const tx = c[i]!;
  c[i] = { ...tx, actions: [{ ...tx.actions[0]!, ...patch }, ...tx.actions.slice(1)] };
}

describe('validateCascade', () => {
  it('accepts a well-formed cascade', () => {
    expect(validateCascade(goodCascade(), ctx)).toMatchObject({ ok: true, reasons: [] });
  });

  it('rejects add_liquidity into a pool that is not allowlisted', () => {
    const c = goodCascade();
    patchAction(c, 2, { args: { pool_id: 5515, amounts: ['1', '1'] } });
    const r = validateCascade(c, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/pool 5515 is not allowlisted/);
  });

  it('rejects add_liquidity when no pool allowlist is given', () => {
    const r = validateCascade(goodCascade(), { ...ctx, allowedPools: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/pool 3879 is not allowlisted/);
  });

  it('rejects an empty cascade', () => {
    const r = validateCascade([], ctx);
    expect(r.ok).toBe(false);
  });

  it('rejects a transaction signed by someone other than the connected account', () => {
    const c = goodCascade();
    c[0] = { ...c[0]!, signerId: accountId('mallory.near') };
    const r = validateCascade(c, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/signer/);
  });

  it('rejects a receiver that is not allowlisted', () => {
    const c = goodCascade();
    c[2] = { ...c[2]!, receiverId: accountId('evil.near') };
    const r = validateCascade(c, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/not allowlisted/);
  });

  it('rejects a non-allowlisted method', () => {
    const c = goodCascade();
    patchAction(c, 2, { methodName: 'withdraw' });
    const r = validateCascade(c, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/method is not allowlisted/);
  });

  it('rejects ft_transfer_call to an unexpected receiver', () => {
    const c = goodCascade();
    patchAction(c, 1, { args: { receiver_id: accountId('evil.near'), amount: '1', msg: '' } });
    const r = validateCascade(c, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/unexpected receiver/);
  });

  it('rejects a non-integer transfer amount', () => {
    const c = goodCascade();
    patchAction(c, 1, { args: { receiver_id: EX, amount: '1.5', msg: '' } });
    const r = validateCascade(c, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/non-negative integer string/);
  });

  it('rejects a deposit over the per-action cap', () => {
    const c = goodCascade();
    patchAction(c, 0, { deposit: MAX_ACTION_DEPOSIT + 1n });
    const r = validateCascade(c, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/per-action cap/);
  });

  it('rejects gas over the ceiling', () => {
    const c = goodCascade();
    patchAction(c, 2, { gas: MAX_ACTION_GAS + 1n });
    const r = validateCascade(c, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/gas/);
  });

  it('rejects when the total attached deposit exceeds the cascade cap', () => {
    // Five registrations at ~0.05 NEAR each = 0.25 NEAR > 0.2 NEAR cap.
    const tx = (i: number): PlannedTransaction => ({
      intentId: `r${i}`,
      signerId: ALICE,
      receiverId: EX,
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'storage_deposit',
          args: { account_id: ALICE },
          gas: 30_000_000_000_000n,
          deposit: MAX_ACTION_DEPOSIT,
        },
      ],
    });
    const r = validateCascade([tx(1), tx(2), tx(3), tx(4), tx(5)], ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/cascade cap/);
  });
});

describe('validateCascade — DCL reposition (exit) cascade', () => {
  const DCL = accountId('dclv2.ref-labs.near');
  const dclCtx = { signerId: ALICE, allowedReceivers: new Set<string>([DCL]) };

  it('accepts remove_liquidity + withdraw_asset on the DCL contract', () => {
    const cascade: PlannedTransaction[] = [
      {
        intentId: 'remove-liquidity',
        signerId: ALICE,
        receiverId: DCL,
        actions: [
          {
            type: 'FunctionCall',
            methodName: 'remove_liquidity',
            args: {
              lpt_id: 'x|y|10000#1',
              amount: '13491808535002',
              min_amount_x: '0',
              min_amount_y: '1',
            },
            gas: 150_000_000_000_000n,
            deposit: 0n,
          },
        ],
      },
      {
        intentId: 'withdraw',
        signerId: ALICE,
        receiverId: DCL,
        actions: [
          {
            type: 'FunctionCall',
            methodName: 'withdraw_asset',
            args: { token_id: 'x' },
            gas: 100_000_000_000_000n,
            deposit: 0n,
          },
          {
            type: 'FunctionCall',
            methodName: 'withdraw_asset',
            args: { token_id: 'y' },
            gas: 100_000_000_000_000n,
            deposit: 0n,
          },
        ],
      },
    ];
    expect(validateCascade(cascade, dclCtx)).toMatchObject({ ok: true, reasons: [] });
  });
});

describe('validateCascade — near_deposit (wrap) exemption', () => {
  const WRAP = accountId('wrap.near');
  const EXCH = accountId('v2.ref-finance.near');
  const wrapCtx = { signerId: ALICE, allowedReceivers: new Set<string>([WRAP, EXCH]) };

  const wrapTx = (deposit: bigint): PlannedTransaction => ({
    intentId: 'wrap',
    signerId: ALICE,
    receiverId: WRAP,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'near_deposit',
        args: {},
        gas: 10_000_000_000_000n,
        deposit,
      },
    ],
  });

  it('allows a large near_deposit (wrapping own NEAR 1:1) past the deposit caps', () => {
    // 327 NEAR wrapped — far above the 0.15/0.3 NEAR storage caps, but it is the user's own value.
    const r = validateCascade([wrapTx(327_000_000_000_000_000_000_000_000n)], wrapCtx);
    expect(r).toMatchObject({ ok: true, reasons: [] });
  });

  it('still rejects near_deposit to a non-allowlisted receiver', () => {
    const tx = {
      ...wrapTx(1_000_000_000_000_000_000_000_000n),
      receiverId: accountId('evil.near'),
    };
    const r = validateCascade([tx], wrapCtx);
    expect(r.ok).toBe(false);
  });

  it('rejects a near_deposit of zero', () => {
    const r = validateCascade([wrapTx(0n)], wrapCtx);
    expect(r.ok).toBe(false);
  });

  it('does not let a wrapping deposit mask an over-cap storage deposit elsewhere', () => {
    const storageOverCap: PlannedTransaction = {
      intentId: 'reg',
      signerId: ALICE,
      receiverId: EXCH,
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'storage_deposit',
          args: { account_id: ALICE },
          gas: 30_000_000_000_000n,
          deposit: 500_000_000_000_000_000_000_000n, // 0.5 NEAR > 0.15 cap
        },
      ],
    };
    const r = validateCascade(
      [wrapTx(10_000_000_000_000_000_000_000_000n), storageOverCap],
      wrapCtx,
    );
    expect(r.ok).toBe(false);
  });
});

describe('validateCascade — per-check result for the policy page', () => {
  it('lists every check as passed for a well-formed cascade, with what it saw', () => {
    const r = validateCascade(goodCascade(), ctx);
    expect(r.checks.map((c) => [c.rule, c.pass])).toEqual([
      ['signer', true],
      ['receivers', true],
      ['methods', true],
      ['gas', true],
      ['deposit', true],
      ['arguments', true],
    ]);
    expect(r.summary).toEqual({
      signer: ALICE,
      receivers: [EX, WNEAR],
      methods: ['storage_deposit', 'ft_transfer_call', 'add_liquidity'],
      gas: '180000000000000',
      deposit: '11020000000000000000001',
    });
  });

  it('marks only the failing rule, with its message', () => {
    const c = goodCascade();
    patchAction(c, 0, { methodName: 'delete_account' });
    const r = validateCascade(c, ctx);
    const failed = r.checks.filter((x) => !x.pass);
    expect(failed.map((x) => x.rule)).toEqual(['methods']);
    expect(failed[0]?.messages.join()).toMatch(/delete_account: method is not allowlisted/);
  });
});
