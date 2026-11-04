import {
  AutopilotError,
  assertChainId,
  checkExportedMethods,
  type AccountId,
  type Brand,
  type Clock,
  type JsonRpcCaller,
  type Network,
  type TokenId,
} from '@near-autopilot/core';
import { type BurrowClient } from './client';
import {
  BURROW_DEPLOYMENTS,
  BURROW_REQUIRED_EXPORTS,
  ORACLE_REQUIRED_EXPORTS,
  TOKEN_REQUIRED_EXPORTS,
} from './constants';

export type BurrowVerificationReason =
  | 'UNLISTED_CONTRACT'
  | 'MISSING_EXPORTS'
  | 'CODE_HASH_NOT_ALLOWED'
  | 'ORACLE_MISMATCH'
  | 'TOKEN_NOT_LISTED'
  | 'TOKEN_NOT_ACCEPTED'
  | 'RESERVED_ACCOUNT'
  | 'EXPIRED'
  | 'WRONG_DEPLOYMENT'
  | 'UNVERIFIED_PROOF';

export class BurrowVerificationError extends AutopilotError {
  constructor(
    readonly reason: BurrowVerificationReason,
    message: string,
  ) {
    super('BURROW_VERIFICATION_FAILED', `${reason}: ${message}`);
  }
}

/**
 * Proof that, moments ago, this exact Burrow contract and its oracle were checked on the chain the RPC
 * reports. Transaction builders accept ONLY this type, and it can only be minted by `BurrowVerifier`,
 * so a transaction cannot be built against an unverified receiver.
 */
export type VerifiedBurrowDeployment = Brand<
  {
    readonly network: Network;
    readonly chainId: string;
    readonly contractId: AccountId;
    /** The oracle Burrow itself is configured with (`get_config.oracle_account_id`), then code-checked. */
    readonly oracleId: AccountId;
    readonly contractCodeHash: string;
    readonly oracleCodeHash: string;
    readonly verifiedAt: Date;
    readonly expiresAt: Date;
  },
  'VerifiedBurrowDeployment'
>;

export type TokenPurpose = 'repay' | 'supply' | 'collateral';

/** Proof that a fungible token is listed by, and accepted by, one specific verified deployment. */
export type VerifiedBurrowToken = Brand<
  {
    readonly tokenId: TokenId;
    readonly burrowContractId: AccountId;
    readonly purpose: TokenPurpose;
    readonly extraDecimals: number;
    readonly tokenCodeHash: string;
    readonly verifiedAt: Date;
    readonly expiresAt: Date;
  },
  'VerifiedBurrowToken'
>;

export interface BurrowVerifierOptions {
  readonly network: Network;
  readonly contractId: AccountId;
  /** If set, `get_config.oracle_account_id` must equal it. Strongly recommended. */
  readonly expectedOracleId?: AccountId;
  /** If set, the deployed code hash must be one of these (exact `view_code` hashes). */
  readonly allowedCodeHashes?: {
    readonly burrow?: readonly string[];
    readonly oracle?: readonly string[];
    readonly tokens?: readonly string[];
  };
  /**
   * By default the contract must be one of `BURROW_DEPLOYMENTS` for `network`. Set only for a fork or a
   * private deployment you control; every other check still applies.
   */
  readonly allowUnlistedContract?: boolean;
  /** How long a verification stays valid. Default 5 minutes. */
  readonly ttlMs?: number;
}

export interface BurrowVerifierDeps {
  readonly rpc: JsonRpcCaller;
  readonly client: BurrowClient;
  readonly clock: Clock;
}

const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * Proofs are branded at the type level AND registered at runtime. A structurally identical object built by
 * hand (plain JS, a cast, a deserialised blob) is not in this set and is refused by the freshness checks.
 */
const minted = new WeakSet<object>();
function mint<T extends object>(proof: T): T {
  Object.freeze(proof);
  minted.add(proof);
  return proof;
}

export class BurrowVerifier {
  private cached: VerifiedBurrowDeployment | null = null;
  private inflight: Promise<VerifiedBurrowDeployment> | null = null;
  private readonly tokens = new Map<string, VerifiedBurrowToken>();
  private readonly ttlMs: number;

  constructor(
    private readonly deps: BurrowVerifierDeps,
    private readonly options: BurrowVerifierOptions,
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (deps.client.contractId !== options.contractId) {
      throw new BurrowVerificationError(
        'WRONG_DEPLOYMENT',
        'client and verifier point at different contracts',
      );
    }
  }

  /** Verifies (or returns a still-valid verification of) the Burrow contract and its oracle. */
  verifyDeployment(): Promise<VerifiedBurrowDeployment> {
    const now = this.deps.clock.now();
    if (this.cached && now < this.cached.expiresAt) return Promise.resolve(this.cached);
    this.inflight ??= this.runDeploymentChecks().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runDeploymentChecks(): Promise<VerifiedBurrowDeployment> {
    const { rpc, client, clock } = this.deps;
    const { network, contractId, expectedOracleId, allowedCodeHashes } = this.options;

    const listed = Object.values(BURROW_DEPLOYMENTS).some(
      (d) => d.network === network && d.contractId === contractId,
    );
    if (!listed && !this.options.allowUnlistedContract) {
      throw new BurrowVerificationError(
        'UNLISTED_CONTRACT',
        `${contractId} is not a known Burrow deployment on ${network}`,
      );
    }

    await assertChainId(rpc, network);

    const burrow = await checkExportedMethods(rpc, contractId, BURROW_REQUIRED_EXPORTS);
    if (!burrow.ok)
      throw new BurrowVerificationError(
        'MISSING_EXPORTS',
        `${contractId} does not export ${burrow.missing.join(', ')}`,
      );
    assertHash('CODE_HASH_NOT_ALLOWED', contractId, burrow.codeHash, allowedCodeHashes?.burrow);

    const config = await client.getConfig();
    const oracleId = config.oracleAccountId;
    if (expectedOracleId && oracleId !== expectedOracleId) {
      throw new BurrowVerificationError(
        'ORACLE_MISMATCH',
        `${contractId} is configured with oracle ${oracleId}, expected ${expectedOracleId}`,
      );
    }

    const oracle = await checkExportedMethods(rpc, oracleId, ORACLE_REQUIRED_EXPORTS);
    if (!oracle.ok)
      throw new BurrowVerificationError(
        'MISSING_EXPORTS',
        `oracle ${oracleId} does not export ${oracle.missing.join(', ')}`,
      );
    assertHash('CODE_HASH_NOT_ALLOWED', oracleId, oracle.codeHash, allowedCodeHashes?.oracle);

    const verifiedAt = clock.now();
    const verified = mint({
      network,
      chainId: network,
      contractId,
      oracleId,
      contractCodeHash: burrow.codeHash,
      oracleCodeHash: oracle.codeHash,
      verifiedAt,
      expiresAt: new Date(verifiedAt.getTime() + this.ttlMs),
    }) as VerifiedBurrowDeployment;
    this.cached = verified;
    this.tokens.clear();
    return verified;
  }

  /**
   * Verifies a token is listed by THIS deployment, can be deposited (and used as collateral, when the
   * purpose needs it), and is a real fungible-token contract. `ft_transfer_call` goes to the token, so the
   * token is a transaction receiver and gets the same scrutiny as Burrow itself.
   */
  async verifyToken(
    deployment: VerifiedBurrowDeployment,
    tokenId: TokenId,
    purpose: TokenPurpose,
  ): Promise<VerifiedBurrowToken> {
    const now = this.deps.clock.now();
    assertDeploymentFresh(deployment, now);
    if (deployment.contractId !== this.options.contractId) {
      throw new BurrowVerificationError(
        'WRONG_DEPLOYMENT',
        'deployment was verified for a different contract',
      );
    }
    if (tokenId === deployment.contractId || tokenId === deployment.oracleId) {
      throw new BurrowVerificationError(
        'RESERVED_ACCOUNT',
        `${tokenId} is a Burrow infrastructure account, not a token`,
      );
    }
    const key = `${tokenId}#${purpose}`;
    const hit = this.tokens.get(key);
    if (hit && now < hit.expiresAt && hit.expiresAt <= deployment.expiresAt) return hit;

    const asset = await this.deps.client.getAsset(tokenId);
    if (!asset)
      throw new BurrowVerificationError(
        'TOKEN_NOT_LISTED',
        `${tokenId} is not listed by ${deployment.contractId}`,
      );
    // ft_on_transfer asserts can_deposit before doing anything (S: fungible_token.rs).
    if (!asset.canDeposit)
      throw new BurrowVerificationError(
        'TOKEN_NOT_ACCEPTED',
        `deposits of ${tokenId} are disabled`,
      );
    if (purpose === 'collateral' && !asset.canUseAsCollateral) {
      throw new BurrowVerificationError(
        'TOKEN_NOT_ACCEPTED',
        `${tokenId} cannot be used as collateral`,
      );
    }

    const code = await checkExportedMethods(this.deps.rpc, tokenId, TOKEN_REQUIRED_EXPORTS);
    if (!code.ok)
      throw new BurrowVerificationError(
        'MISSING_EXPORTS',
        `${tokenId} does not export ${code.missing.join(', ')}`,
      );
    assertHash(
      'CODE_HASH_NOT_ALLOWED',
      tokenId,
      code.codeHash,
      this.options.allowedCodeHashes?.tokens,
    );

    const verifiedAt = this.deps.clock.now();
    const verified = mint({
      tokenId,
      burrowContractId: deployment.contractId,
      purpose,
      extraDecimals: asset.extraDecimals,
      tokenCodeHash: code.codeHash,
      verifiedAt,
      expiresAt: new Date(
        Math.min(verifiedAt.getTime() + this.ttlMs, deployment.expiresAt.getTime()),
      ),
    }) as VerifiedBurrowToken;
    this.tokens.set(key, verified);
    return verified;
  }
}

function assertHash(
  reason: BurrowVerificationReason,
  account: AccountId,
  actual: string,
  allowed: readonly string[] | undefined,
): void {
  if (allowed && !allowed.includes(actual)) {
    throw new BurrowVerificationError(
      reason,
      `code hash ${actual} of ${account} is not in the allowed list`,
    );
  }
}

export function assertDeploymentFresh(deployment: VerifiedBurrowDeployment, now: Date): void {
  if (!minted.has(deployment))
    throw new BurrowVerificationError(
      'UNVERIFIED_PROOF',
      'deployment proof was not issued by a BurrowVerifier',
    );
  if (now >= deployment.expiresAt)
    throw new BurrowVerificationError(
      'EXPIRED',
      'deployment verification has expired; verify again',
    );
}

export function assertTokenFresh(
  token: VerifiedBurrowToken,
  deployment: VerifiedBurrowDeployment,
  now: Date,
): void {
  assertDeploymentFresh(deployment, now);
  if (!minted.has(token))
    throw new BurrowVerificationError(
      'UNVERIFIED_PROOF',
      'token proof was not issued by a BurrowVerifier',
    );
  if (token.burrowContractId !== deployment.contractId) {
    throw new BurrowVerificationError(
      'WRONG_DEPLOYMENT',
      'token was verified against a different Burrow contract',
    );
  }
  if (now >= token.expiresAt)
    throw new BurrowVerificationError('EXPIRED', `verification of ${token.tokenId} has expired`);
}
