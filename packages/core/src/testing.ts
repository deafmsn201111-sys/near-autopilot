// Test doubles for the core ports. Exported on a separate entry point so production
// bundles never include them. Everything here implements an explicit port interface.
import { planHash } from './hash';
import type { AccountId } from './ids';
import type { ApprovedPlan, PlannedTransaction } from './plan';
import type { ApprovalAuthority, Clock, ContractViewer, IdGenerator, Logger } from './ports';

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  constructor(private readonly prefix = 'id') {}
  next(): string {
    this.n += 1;
    return `${this.prefix}-${this.n}`;
  }
}

export class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

export interface ViewCall {
  readonly contractId: string;
  readonly methodName: string;
  readonly args: Record<string, unknown>;
}

type Handler = (args: Record<string, unknown>) => unknown;

/**
 * Scripted ContractViewer for unit tests: responses are registered per `contract#method`
 * and every call is recorded. Unregistered calls throw so tests cannot pass by accident.
 */
export class ScriptedContractViewer implements ContractViewer {
  readonly calls: ViewCall[] = [];
  private readonly handlers = new Map<string, Handler>();

  /** Always answer `contract#method` with a fixed response. */
  on(contractId: string, methodName: string, response: unknown): this {
    this.handlers.set(`${contractId}#${methodName}`, () => response);
    return this;
  }

  /** Answer `contract#method` by computing a response from the call arguments. */
  onCall(contractId: string, methodName: string, handler: Handler): this {
    this.handlers.set(`${contractId}#${methodName}`, handler);
    return this;
  }

  async view(
    contractId: AccountId,
    methodName: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    this.calls.push({ contractId, methodName, args });
    const handler = this.handlers.get(`${contractId}#${methodName}`);
    if (!handler)
      throw new Error(`ScriptedContractViewer: no handler for ${contractId}#${methodName}`);
    return handler(args);
  }
}

/**
 * Stand-in for the policy engine's approval minting, for executor tests that must not depend on policy-engine.
 * Only approvals returned by `mint` are authentic; copies and hand-built objects are not.
 */
export class TestApprovalAuthority implements ApprovalAuthority {
  private readonly minted = new WeakSet<ApprovedPlan>();

  mint(
    plan: PlannedTransaction,
    opts: { now: Date; ttlSeconds?: number; decisionId?: string },
  ): ApprovedPlan {
    const approved = {
      plan,
      decisionId: opts.decisionId ?? 'test-decision',
      planHash: planHash(plan),
      approvedAt: opts.now,
      expiresAt: new Date(opts.now.getTime() + (opts.ttlSeconds ?? 60) * 1000),
    } as ApprovedPlan;
    this.minted.add(approved);
    return approved;
  }

  isAuthentic(approved: ApprovedPlan): boolean {
    return this.minted.has(approved);
  }
}
