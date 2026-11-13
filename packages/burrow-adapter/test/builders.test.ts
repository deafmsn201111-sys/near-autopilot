import { describe, expect, it } from 'vitest';
import {
  BURROW_GAS,
  buildBorrow,
  buildBurrowStorageDeposit,
  buildIncreaseCollateralFromSupplied,
  buildRepay,
  buildRepayFromCollateral,
  buildSupply,
  buildSupplyAsCollateral,
  buildWithdraw,
  BurrowVerificationError,
  type VerifiedBurrowDeployment,
  type VerifiedBurrowToken,
} from '../src';
import { BURROW, BURROW_BETA, makeWorld, ORACLE, USDT, WNEAR } from './support/fixtures';

async function setup() {
  const w = makeWorld();
  const deployment = await w.verifier.verifyDeployment();
  const tokens = {
    usdtRepay: await w.verifier.verifyToken(deployment, USDT, 'repay'),
    usdtSupply: await w.verifier.verifyToken(deployment, USDT, 'supply'),
    nearCollateral: await w.verifier.verifyToken(deployment, WNEAR, 'collateral'),
    nearSupply: await w.verifier.verifyToken(deployment, WNEAR, 'supply'),
  };
  return { w, deployment, tokens, now: w.clock.now() };
}

describe('buildRepay', () => {
  it('sends ft_transfer_call to the TOKEN with an Execute/Repay message capped in INNER units', async () => {
    const { deployment, tokens, now } = await setup();
    const tx = buildRepay({ deployment, token: tokens.usdtRepay, now, rawAmount: 42n });
    expect(tx.network).toBe('mainnet');
    expect(tx.receiverId).toBe(USDT);
    expect(tx.actions).toHaveLength(1);
    const action = tx.actions[0]!;
    expect(action.methodName).toBe('ft_transfer_call');
    expect(action.deposit).toBe(1n);
    expect(action.gas).toBe(BURROW_GAS.ftTransferCall);
    expect(action.args['receiver_id']).toBe(BURROW);
    expect(action.args['amount']).toBe('42');
    expect(typeof action.args['msg']).toBe('string');
    expect(JSON.parse(String(action.args['msg']))).toEqual({
      Execute: { actions: [{ Repay: { token_id: USDT, max_amount: '42000000000000' } }] },
    });
  });

  it('uses extra_decimals 0 for wNEAR (raw == inner)', async () => {
    const { deployment, tokens, now } = await setup();
    const tx = buildRepay({ deployment, token: tokens.nearSupply, now, rawAmount: 7n });
    expect(JSON.parse(String(tx.actions[0]!.args['msg']))).toEqual({
      Execute: { actions: [{ Repay: { token_id: WNEAR, max_amount: '7' } }] },
    });
  });

  it('rejects non-positive amounts', async () => {
    const { deployment, tokens, now } = await setup();
    expect(() => buildRepay({ deployment, token: tokens.usdtRepay, now, rawAmount: 0n })).toThrow(
      RangeError,
    );
    expect(() => buildRepay({ deployment, token: tokens.usdtRepay, now, rawAmount: -1n })).toThrow(
      RangeError,
    );
  });

  it('rejects an expired token proof and an expired deployment proof', async () => {
    const { deployment, tokens, w } = await setup();
    const later = new Date(w.clock.now().getTime() + 10 * 60_000);
    expect(() =>
      buildRepay({ deployment, token: tokens.usdtRepay, now: later, rawAmount: 1n }),
    ).toThrow(BurrowVerificationError);
  });

  it('rejects a token proof issued for another Burrow contract', async () => {
    const { deployment, now } = await setup();
    const beta = makeWorld({ contractId: BURROW_BETA });
    const betaDeployment = await beta.verifier.verifyDeployment();
    const betaToken = await beta.verifier.verifyToken(betaDeployment, USDT, 'repay');
    expect(() => buildRepay({ deployment, token: betaToken, now, rawAmount: 1n })).toThrow(
      'WRONG_DEPLOYMENT',
    );
  });
});

describe('buildSupplyAsCollateral / buildSupply', () => {
  it('builds an IncreaseCollateral message and requires the collateral purpose', async () => {
    const { deployment, tokens, now } = await setup();
    const tx = buildSupplyAsCollateral({
      deployment,
      token: tokens.nearCollateral,
      now,
      rawAmount: 5n,
    });
    expect(tx.receiverId).toBe(WNEAR);
    expect(JSON.parse(String(tx.actions[0]!.args['msg']))).toEqual({
      Execute: { actions: [{ IncreaseCollateral: { token_id: WNEAR, max_amount: '5' } }] },
    });
    expect(() =>
      buildSupplyAsCollateral({ deployment, token: tokens.nearSupply, now, rawAmount: 5n }),
    ).toThrow('TOKEN_NOT_ACCEPTED');
  });

  it('plain supply uses an empty msg and refuses a repay-only proof', async () => {
    const { deployment, tokens, now } = await setup();
    const tx = buildSupply({ deployment, token: tokens.usdtSupply, now, rawAmount: 9n });
    expect(tx.actions[0]!.args['msg']).toBe('');
    expect(tx.actions[0]!.args['amount']).toBe('9');
    expect(() => buildSupply({ deployment, token: tokens.usdtRepay, now, rawAmount: 9n })).toThrow(
      'TOKEN_NOT_ACCEPTED',
    );
  });
});

describe('buildIncreaseCollateralFromSupplied', () => {
  it('calls execute on Burrow itself with 1 yocto and INNER units', async () => {
    const { deployment, tokens, now } = await setup();
    const tx = buildIncreaseCollateralFromSupplied({
      deployment,
      token: tokens.nearCollateral,
      now,
      innerAmount: 123n,
    });
    expect(tx.receiverId).toBe(BURROW);
    const a = tx.actions[0]!;
    expect(a.methodName).toBe('execute');
    expect(a.deposit).toBe(1n);
    expect(a.gas).toBe(BURROW_GAS.execute);
    expect(a.args).toEqual({
      actions: [{ IncreaseCollateral: { token_id: WNEAR, max_amount: '123' } }],
    });
  });

  it('omits max_amount to move the whole supplied balance', async () => {
    const { deployment, tokens, now } = await setup();
    const tx = buildIncreaseCollateralFromSupplied({
      deployment,
      token: tokens.nearCollateral,
      now,
    });
    expect(tx.actions[0]!.args).toEqual({ actions: [{ IncreaseCollateral: { token_id: WNEAR } }] });
  });

  it('requires the collateral purpose, a positive amount and fresh proofs', async () => {
    const { deployment, tokens, now, w } = await setup();
    expect(() =>
      buildIncreaseCollateralFromSupplied({ deployment, token: tokens.nearSupply, now }),
    ).toThrow('TOKEN_NOT_ACCEPTED');
    expect(() =>
      buildIncreaseCollateralFromSupplied({
        deployment,
        token: tokens.nearCollateral,
        now,
        innerAmount: 0n,
      }),
    ).toThrow(RangeError);
    const later = new Date(w.clock.now().getTime() + 10 * 60_000);
    expect(() =>
      buildIncreaseCollateralFromSupplied({ deployment, token: tokens.nearCollateral, now: later }),
    ).toThrow('EXPIRED');
  });
});

describe('proofs cannot be forged', () => {
  it('rejects hand-made or copied proofs at runtime (the brand is also enforced by the type system)', async () => {
    const { deployment, tokens, now } = await setup();
    const forgedDeployment = { ...deployment } as VerifiedBurrowDeployment;
    const forgedToken = { ...tokens.usdtRepay } as VerifiedBurrowToken;
    expect(() =>
      buildRepay({ deployment: forgedDeployment, token: tokens.usdtRepay, now, rawAmount: 1n }),
    ).toThrow('UNVERIFIED_PROOF');
    expect(() => buildRepay({ deployment, token: forgedToken, now, rawAmount: 1n })).toThrow(
      'UNVERIFIED_PROOF',
    );
    const handMade = {
      network: 'mainnet',
      chainId: 'mainnet',
      contractId: BURROW,
      oracleId: ORACLE,
      expiresAt: new Date(9e15),
    };
    expect(() =>
      buildRepay({
        // @ts-expect-error a plain object is not a VerifiedBurrowDeployment (it lacks the brand)
        deployment: handMade,
        token: tokens.usdtRepay,
        now,
        rawAmount: 1n,
      }),
    ).toThrow('UNVERIFIED_PROOF');
  });

  it('issued proofs are frozen', async () => {
    const { deployment, tokens } = await setup();
    expect(Object.isFrozen(deployment)).toBe(true);
    expect(Object.isFrozen(tokens.usdtRepay)).toBe(true);
  });
});

describe('buildBurrowStorageDeposit', () => {
  it('registers the signer on the Burrow contract with registration_only and the given min deposit', async () => {
    const { deployment } = await setup();
    const tx = buildBurrowStorageDeposit({
      deployment,
      accountId: WNEAR, // any account id stands in here
      deposit: 250_000_000_000_000_000_000_000n, // 0.25 NEAR (caller passes storage_balance_bounds().min)
    });
    expect(tx.receiverId).toBe(deployment.contractId);
    expect(tx.actions).toHaveLength(1);
    const a = tx.actions[0];
    expect(a?.methodName).toBe('storage_deposit');
    expect(a?.args).toEqual({ account_id: WNEAR, registration_only: true });
    expect(a?.deposit).toBe(250_000_000_000_000_000_000_000n);
  });

  it('refuses a non-positive deposit (registration stakes real storage)', async () => {
    const { deployment } = await setup();
    expect(() =>
      buildBurrowStorageDeposit({ deployment, accountId: WNEAR, deposit: 0n }),
    ).toThrow();
  });
});

describe('buildBorrow / buildWithdraw (priced via oracle_call)', () => {
  it('buildBorrow calls oracle_call on the ORACLE with Borrow + Withdraw in inner units', async () => {
    const { deployment, w, now } = await setup();
    const usdtBorrow = await w.verifier.verifyToken(deployment, USDT, 'borrow');
    const tx = buildBorrow({
      deployment,
      token: usdtBorrow,
      now,
      rawAmount: 42n,
      assetIds: [USDT, WNEAR],
    });
    expect(tx.receiverId).toBe(ORACLE);
    const a = tx.actions[0]!;
    expect(a.methodName).toBe('oracle_call');
    expect(a.deposit).toBe(1n);
    expect(a.gas).toBe(BURROW_GAS.oracleCall);
    expect(a.args['receiver_id']).toBe(BURROW);
    expect(a.args['asset_ids']).toEqual([USDT, WNEAR]);
    expect(JSON.parse(String(a.args['msg']))).toEqual({
      Execute: {
        actions: [
          { Borrow: { token_id: USDT, amount: '42000000000000' } },
          { Withdraw: { token_id: USDT, max_amount: '42000000000000' } },
        ],
      },
    });
  });

  it('buildWithdraw calls oracle_call with a single capped Withdraw', async () => {
    const { deployment, w, now } = await setup();
    const usdtWithdraw = await w.verifier.verifyToken(deployment, USDT, 'withdraw');
    const tx = buildWithdraw({
      deployment,
      token: usdtWithdraw,
      now,
      rawAmount: 7n,
      assetIds: [USDT],
    });
    expect(tx.receiverId).toBe(ORACLE);
    expect(JSON.parse(String(tx.actions[0]!.args['msg']))).toEqual({
      Execute: { actions: [{ Withdraw: { token_id: USDT, max_amount: '7000000000000' } }] },
    });
  });

  it('rejects empty assetIds and non-positive amounts', async () => {
    const { deployment, w, now } = await setup();
    const t = await w.verifier.verifyToken(deployment, USDT, 'borrow');
    expect(() => buildBorrow({ deployment, token: t, now, rawAmount: 42n, assetIds: [] })).toThrow(
      RangeError,
    );
    expect(() =>
      buildBorrow({ deployment, token: t, now, rawAmount: 0n, assetIds: [USDT] }),
    ).toThrow(RangeError);
  });

  it('refuses a token verified for the wrong purpose', async () => {
    const { deployment, w, now } = await setup();
    const supplyToken = await w.verifier.verifyToken(deployment, USDT, 'supply');
    expect(() =>
      buildBorrow({ deployment, token: supplyToken, now, rawAmount: 1n, assetIds: [USDT] }),
    ).toThrow(BurrowVerificationError);
  });
});

describe('buildRepayFromCollateral (priced via oracle_call)', () => {
  it('decreases collateral and repays the same token in one Execute, both capped in inner units', async () => {
    const { deployment, tokens, now } = await setup();
    const tx = buildRepayFromCollateral({
      deployment,
      token: tokens.usdtRepay,
      now,
      rawAmount: 42n,
      fromCollateralRaw: 40n,
      assetIds: [USDT],
    });
    expect(tx.receiverId).toBe(ORACLE);
    const a = tx.actions[0]!;
    expect(a.methodName).toBe('oracle_call');
    expect(a.deposit).toBe(1n);
    expect(a.args['receiver_id']).toBe(BURROW);
    expect(JSON.parse(String(a.args['msg']))).toEqual({
      Execute: {
        actions: [
          { DecreaseCollateral: { token_id: USDT, max_amount: '40000000000000' } },
          { Repay: { token_id: USDT, max_amount: '42000000000000' } },
        ],
      },
    });
  });

  it('repays from the plain supplied balance alone when no collateral needs to move', async () => {
    const { deployment, tokens, now } = await setup();
    const tx = buildRepayFromCollateral({
      deployment,
      token: tokens.usdtRepay,
      now,
      rawAmount: 5n,
      fromCollateralRaw: 0n,
      assetIds: [USDT],
    });
    expect(JSON.parse(String(tx.actions[0]!.args['msg']))).toEqual({
      Execute: { actions: [{ Repay: { token_id: USDT, max_amount: '5000000000000' } }] },
    });
  });

  it('refuses a non-positive amount, more collateral than the repayment, and a borrow-only proof', async () => {
    const { deployment, tokens, w, now } = await setup();
    const base = { deployment, token: tokens.usdtRepay, now, assetIds: [USDT] };
    expect(() =>
      buildRepayFromCollateral({ ...base, rawAmount: 0n, fromCollateralRaw: 0n }),
    ).toThrow(RangeError);
    expect(() =>
      buildRepayFromCollateral({ ...base, rawAmount: 5n, fromCollateralRaw: 6n }),
    ).toThrow(RangeError);
    const borrowOnly = await w.verifier.verifyToken(deployment, USDT, 'borrow');
    expect(() =>
      buildRepayFromCollateral({
        ...base,
        token: borrowOnly,
        rawAmount: 5n,
        fromCollateralRaw: 0n,
      }),
    ).toThrow(BurrowVerificationError);
  });
});

describe('buildWithdraw from collateral', () => {
  it('decreases collateral first when the plain supplied balance does not cover the withdrawal', async () => {
    const { deployment, w, now } = await setup();
    const t = await w.verifier.verifyToken(deployment, USDT, 'withdraw');
    const tx = buildWithdraw({
      deployment,
      token: t,
      now,
      rawAmount: 7n,
      fromCollateralRaw: 3n,
      assetIds: [USDT],
    });
    expect(JSON.parse(String(tx.actions[0]!.args['msg']))).toEqual({
      Execute: {
        actions: [
          { DecreaseCollateral: { token_id: USDT, max_amount: '3000000000000' } },
          { Withdraw: { token_id: USDT, max_amount: '7000000000000' } },
        ],
      },
    });
  });
});
