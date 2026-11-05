import type { AccountId, TokenId } from './ids';
import type {
  AssetRisk,
  LendingPosition,
  PriceMap,
  PortfolioSnapshot,
  SwapQuote,
  SwapQuoteRequest,
  TokenInfo,
} from './domain';
import type { ActionIntent } from './intents';
import type { ApprovedPlan, ExecutionResult, PlannedTransaction } from './plan';

/* ------------------------------ infrastructure ------------------------------ */

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/* ------------------------------ chain read ports ------------------------------ */

/** Read-only contract call. Implemented over NEAR JSON-RPC by `near-adapter`. */
export interface ContractViewer {
  view(contractId: AccountId, methodName: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface NativeBalanceReader {
  /** Spendable NEAR balance in yoctoNEAR. */
  getNativeBalance(accountId: AccountId): Promise<bigint>;
}

/** NEP-141 fungible token reads plus NEP-145 storage registration. */
export interface TokenReader {
  getBalance(token: TokenId, accountId: AccountId): Promise<bigint>;
  getMetadata(token: TokenId): Promise<TokenInfo>;
  /** True if `accountId` has a storage deposit on `token` and can therefore receive it. */
  isStorageRegistered(token: TokenId, accountId: AccountId): Promise<boolean>;
}

export interface PriceOracle {
  /** Tokens without a published price are absent from the result (callers must fail closed). */
  getPrices(tokens: readonly TokenId[]): Promise<{ prices: PriceMap; asOf: Date }>;
}

export interface LendingReader {
  getPosition(accountId: AccountId): Promise<LendingPosition>;
  getRisk(tokens: readonly TokenId[]): Promise<ReadonlyMap<TokenId, AssetRisk>>;
}

export interface SwapQuoter {
  /** Best executable quote across the venue's configured pools, or null if none. */
  quote(request: SwapQuoteRequest): Promise<SwapQuote | null>;
}

/* ------------------------------ agents ------------------------------ */

export interface AgentContext {
  readonly snapshot: PortfolioSnapshot;
  readonly quoter: SwapQuoter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface Agent {
  readonly id: string;
  /** Pure decision step: observe the snapshot, propose intents. Must not perform writes. */
  evaluate(context: AgentContext): Promise<readonly ActionIntent[]>;
}

/* ------------------------------ planning & execution ------------------------------ */

export interface ProtocolPlanner {
  readonly protocol: ActionIntent['protocol'];
  supports(intent: ActionIntent): boolean;
  plan(intent: ActionIntent, signerId: AccountId): Promise<PlannedTransaction>;
}

/** What an access key may sign, as the chain reports it (`view_access_key`). */
export type AccessKeyPermission =
  | { readonly kind: 'full_access' }
  | {
      readonly kind: 'function_call';
      readonly receiverId: string;
      /** Empty = any method of `receiverId`. */
      readonly methodNames: readonly string[];
      /** Remaining gas allowance in yoctoNEAR; null = unlimited. */
      readonly allowance: bigint | null;
    };

export interface ChainContext {
  readonly nonce: bigint;
  readonly blockHash: string;
  /** The signing key's permission, read in the same query as the nonce. Executors refuse unsafe keys on it. */
  readonly permission: AccessKeyPermission;
}

export interface ChainContextProvider {
  /** Next usable nonce for the access key and a recent block hash. */
  getContext(signerId: AccountId, publicKey: string): Promise<ChainContext>;
}

export interface SignedTransaction {
  readonly hash: string;
  readonly payloadBase64: string;
}

/**
 * Custody boundary. The repository ships no key-holding implementation: provide one backed by
 * your KMS/HSM or a locked-down function-call access key.
 */
export interface TransactionSigner {
  readonly accountId: AccountId;
  readonly publicKey: string;
  /** Signs with the nonce and block hash; the key permission is the executor's concern, not the signer's. */
  sign(
    transaction: PlannedTransaction,
    context: Pick<ChainContext, 'nonce' | 'blockHash'>,
  ): Promise<SignedTransaction>;
}

export interface BroadcastResult {
  readonly txHash: string;
  readonly status: 'success' | 'failure';
  readonly failureReason: string | null;
}

export interface TransactionBroadcaster {
  broadcast(signed: SignedTransaction, signerId: AccountId): Promise<BroadcastResult>;
}

export interface PlanExecutor {
  execute(approved: ApprovedPlan): Promise<ExecutionResult>;
}

/**
 * Runtime proof of origin for an `ApprovedPlan`. The `ApprovedPlan` brand is compile-time only, so a cast or a
 * structural copy would otherwise pass for a real approval. Implemented by the policy engine (which records every
 * approval it mints); executors refuse anything it does not recognise.
 */
export interface ApprovalAuthority {
  isAuthentic(approved: ApprovedPlan): boolean;
}

export type { PortfolioSnapshot };
