import { describe, expect, it } from 'vitest';
import {
  accountId,
  type ApprovedPlan,
  type BroadcastResult,
  type ChainContext,
  type ChainContextProvider,
  type PlannedTransaction,
  type SignedTransaction,
  type TransactionBroadcaster,
  type TransactionSigner,
  type ActionIntent,
  type ProtocolPlanner,
} from '@near-autopilot/core';
import { planHash } from '@near-autopilot/core/hash';
import { FixedClock, SilentLogger } from '@near-autopilot/core/testing';
import { DryRunExecutor, PlannerRegistry, TransactionExecutor, verifyApproval } from '../src';

const ALICE = accountId('alice.near');
const NOW = new Date('2026-11-03T12:00:00Z');

const plan: PlannedTransaction = {
  intentId: 'intent-1',
  signerId: ALICE,
  receiverId: accountId('wrap.near'),
  actions: [
    {
      type: 'FunctionCall',
      methodName: 'ft_transfer_call',
      args: { amount: '1' },
      gas: 1n,
      deposit: 1n,
    },
  ],
};

// Test-only minting; in production only PolicyEngine.approve produces these.
const approve = (p: PlannedTransaction = plan, ttlSeconds = 60): ApprovedPlan =>
  ({
    plan: p,
    decisionId: 'd1',
    planHash: planHash(p),
    approvedAt: NOW,
    expiresAt: new Date(NOW.getTime() + ttlSeconds * 1000),
  }) as ApprovedPlan;

class RecordingSigner implements TransactionSigner {
  readonly accountId = ALICE;
  readonly publicKey = 'ed25519:test';
  readonly signed: PlannedTransaction[] = [];
  async sign(tx: PlannedTransaction, ctx: ChainContext): Promise<SignedTransaction> {
    this.signed.push(tx);
    return { hash: `hash-${ctx.nonce}`, payloadBase64: 'AAAA' };
  }
}
class FixedContext implements ChainContextProvider {
  async getContext(): Promise<ChainContext> {
    return { nonce: 7n, blockHash: 'b'.repeat(44) };
  }
}
class ScriptedBroadcaster implements TransactionBroadcaster {
  readonly sent: SignedTransaction[] = [];
  constructor(private readonly outcome: BroadcastResult | Error) {}
  async broadcast(signed: SignedTransaction): Promise<BroadcastResult> {
    this.sent.push(signed);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

const build = (outcome: BroadcastResult | Error, signer = new RecordingSigner()) => {
  const broadcaster = new ScriptedBroadcaster(outcome);
  const executor = new TransactionExecutor({
    signer,
    contextProvider: new FixedContext(),
    broadcaster,
    clock: new FixedClock(NOW),
    logger: new SilentLogger(),
  });
  return { executor, signer, broadcaster };
};

describe('verifyApproval', () => {
  it('accepts a fresh, untampered approval', () => {
    expect(() => verifyApproval(approve(), NOW)).not.toThrow();
  });
  it('rejects expired approvals', () => {
    expect(() => verifyApproval(approve(plan, 60), new Date(NOW.getTime() + 61_000))).toThrow(
      'expired',
    );
  });
  it('rejects plans modified after approval', () => {
    const approved = approve();
    const tampered = {
      ...approved,
      plan: { ...plan, receiverId: accountId('attacker.near') },
    } as ApprovedPlan;
    expect(() => verifyApproval(tampered, NOW)).toThrow('modified after approval');
  });
});

describe('TransactionExecutor', () => {
  it('signs and broadcasts an approved plan', async () => {
    const { executor, signer, broadcaster } = build({
      txHash: 'TX1',
      status: 'success',
      failureReason: null,
    });
    const result = await executor.execute(approve());
    expect(result).toEqual({ status: 'success', mode: 'live', txHash: 'TX1', error: null });
    expect(signer.signed).toEqual([plan]);
    expect(broadcaster.sent[0]?.hash).toBe('hash-7');
  });

  it('reports on-chain failure without throwing', async () => {
    const { executor } = build({
      txHash: 'TX2',
      status: 'failure',
      failureReason: 'receipt r2 failed',
    });
    expect(await executor.execute(approve())).toMatchObject({
      status: 'failed',
      txHash: 'TX2',
      error: 'receipt r2 failed',
    });
  });

  it('captures broadcaster errors as failed results', async () => {
    const { executor } = build(new Error('network down'));
    expect(await executor.execute(approve())).toMatchObject({
      status: 'failed',
      error: 'network down',
      txHash: null,
    });
  });

  it('refuses tampered, expired and replayed approvals without signing', async () => {
    const { executor, signer } = build({ txHash: 'TX', status: 'success', failureReason: null });
    const tampered = {
      ...approve(),
      plan: { ...plan, receiverId: accountId('attacker.near') },
    } as ApprovedPlan;
    expect((await executor.execute(tampered)).status).toBe('rejected');
    expect((await executor.execute(approve(plan, -1))).status).toBe('rejected');
    expect((await executor.execute(approve())).status).toBe('success');
    const replay = await executor.execute(approve());
    expect(replay).toMatchObject({ status: 'rejected', error: 'Approval has already been used' });
    expect(signer.signed).toHaveLength(1);
  });

  it('refuses plans for a different signer', async () => {
    const { executor, signer } = build({ txHash: 'TX', status: 'success', failureReason: null });
    const other = approve({ ...plan, signerId: accountId('bob.near') });
    expect((await executor.execute(other)).status).toBe('rejected');
    expect(signer.signed).toHaveLength(0);
  });
});

describe('DryRunExecutor', () => {
  it('verifies the approval but never signs or sends', async () => {
    const dry = new DryRunExecutor({ clock: new FixedClock(NOW), logger: new SilentLogger() });
    expect(await dry.execute(approve())).toEqual({
      status: 'dry_run',
      mode: 'dry-run',
      txHash: null,
      error: null,
    });
    expect((await dry.execute(approve(plan, -1))).status).toBe('rejected');
  });
});

describe('PlannerRegistry', () => {
  const swap: ActionIntent = {
    id: 'i',
    agentId: 'a',
    reason: 'r',
    kind: 'swap',
    protocol: 'rhea',
    tokenIn: accountId('a.near'),
    tokenOut: accountId('b.near'),
    amountIn: 1n,
    poolId: 1,
    quotedAmountOut: 1n,
    minAmountOut: 1n,
    slippageBps: 0,
  };
  const planner: ProtocolPlanner = {
    protocol: 'rhea',
    supports: (i) => i.kind === 'swap',
    plan: async () => plan,
  };

  it('routes to the matching planner and fails for unsupported intents', async () => {
    const registry = new PlannerRegistry().register(planner);
    expect(await registry.plan(swap, ALICE)).toBe(plan);
    await expect(
      registry.plan(
        {
          ...swap,
          kind: 'lending.repay',
          protocol: 'burrow',
          token: accountId('a.near'),
          amount: 1n,
        },
        ALICE,
      ),
    ).rejects.toThrow('No planner supports');
  });
});
