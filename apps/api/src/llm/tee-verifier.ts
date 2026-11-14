import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import type { SignedReply } from '@near-autopilot/orchestrator';
import { z } from 'zod';
import { NEAR_AI_URL } from './near-ai-client';

/** Whether every reply of one analysis was signed inside the attested TEE. Stored with the call and shown to the user. */
export interface PrivacyCheck {
  readonly verified: boolean;
  /** Why not, in a fixed phrase (never provider text); null when verified. */
  readonly reason: string | null;
  readonly chatIds: readonly string[];
}

export interface TeeVerifierConfig {
  readonly apiKey: string;
  readonly model: string;
  /** Bounds one `verify`, retries of a not-yet-recorded signature included. */
  readonly waitMs?: number;
  readonly retryMs?: number;
}

const REPORT_TTL_MS = 60 * 60_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const reportsSchema = z.object({
  model_attestations: z
    .array(
      z.object({
        signing_address: z.string().regex(ADDRESS),
        signing_algo: z.literal('ecdsa'),
        request_nonce: z.string(),
      }),
    )
    .min(1),
});

const signatureSchema = z.object({
  text: z.string(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  signature_kind: z.string(),
});

class Unverified extends Error {}

/**
 * Checks NEAR AI Cloud's per-reply ECDSA signatures against the model's attestation reports. It checks that the reports
 * echo our nonce and that the reply was signed by an attested key over exactly our request and response bytes; the
 * Intel / NVIDIA quotes themselves are left to the official verifier (KNOWN_ISSUES). Instances of a model share a key,
 * so several reports with one address are one key.
 */
export class TeeVerifier {
  private reports: { keys: ReadonlySet<string>; at: number } | null = null;

  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly config: TeeVerifierConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async verify(replies: readonly SignedReply[]): Promise<PrivacyCheck> {
    const chatIds = replies.map((r) => r.chatId);
    const signal = AbortSignal.timeout(this.config.waitMs ?? 3000);
    try {
      if (replies.length === 0) throw new Unverified('no reply');
      // Fetched side by side; the reports are awaited first, so their failure is the reason given.
      const signing = Promise.all(replies.map((r) => this.signer(r, signal)));
      signing.catch(() => undefined);
      let keys = await this.attestedKeys(signal, false);
      const signed = await signing;
      if (signed.some((s) => !keys.has(s))) keys = await this.attestedKeys(signal, true);
      if (signed.some((s) => !keys.has(s))) throw new Unverified('signer is not the attested key');
      return { verified: true, reason: null, chatIds };
    } catch (e) {
      return {
        verified: false,
        reason: e instanceof Unverified ? e.message : 'check failed',
        chatIds,
      };
    }
  }

  private async attestedKeys(signal: AbortSignal, refresh: boolean): Promise<ReadonlySet<string>> {
    if (!refresh && this.reports && this.now() - this.reports.at < REPORT_TTL_MS)
      return this.reports.keys;
    const nonce = randomBytes(32).toString('hex');
    const url = new URL(`${NEAR_AI_URL}/attestation/report`);
    url.search = new URLSearchParams({
      model: this.config.model,
      provider: 'near',
      signing_algo: 'ecdsa',
      nonce,
    }).toString();
    const body = await this.get(url, signal, { 'x-no-aliasing': 'true' }).catch(() => {
      throw new Unverified('attestation unavailable');
    });
    const parsed = reportsSchema.safeParse(body);
    if (!parsed.success) throw new Unverified('attestation unavailable');
    const reports = parsed.data.model_attestations;
    if (reports.some((r) => r.request_nonce !== nonce))
      throw new Unverified('attestation nonce mismatch');
    const keys = new Set(reports.map((r) => r.signing_address.toLowerCase()));
    this.reports = { keys, at: this.now() };
    return keys;
  }

  /** The recovered address that signed this reply, once its text is exactly ours. */
  private async signer(reply: SignedReply, signal: AbortSignal): Promise<string> {
    const sig = await this.signature(reply.chatId, signal);
    if (sig.signature_kind !== 'provider_tee')
      throw new Unverified('signature is not from the TEE');
    if (sig.text !== `${this.config.model}:${reply.requestSha256}:${reply.responseSha256}`)
      throw new Unverified('signed text does not match the reply');
    return recoverEip191(sig.text, sig.signature);
  }

  /** A signature may be recorded a moment after the reply: any non-signature answer is retried until the deadline. */
  private async signature(chatId: string, signal: AbortSignal) {
    const url = new URL(`${NEAR_AI_URL}/signature/${encodeURIComponent(chatId)}`);
    url.searchParams.set('signing_algo', 'ecdsa');
    for (;;) {
      const body = await this.get(url, signal, {}, true).catch(() => {
        throw new Unverified('no signature');
      });
      const parsed = signatureSchema.safeParse(body);
      if (parsed.success) return parsed.data;
      await new Promise((r) => setTimeout(r, this.config.retryMs ?? 500));
      if (signal.aborted) throw new Unverified('no signature');
    }
  }

  /** `retryable`: an HTTP error or a body that is not JSON reads as an empty answer instead of a failure. */
  private async get(
    url: URL,
    signal: AbortSignal,
    headers: Record<string, string>,
    retryable = false,
  ): Promise<unknown> {
    const res = await this.fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
        ...headers,
      },
      signal,
    });
    if (retryable && !res.ok) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return retryable ? await res.json().catch(() => null) : await res.json();
  }
}

function recoverEip191(text: string, signature: string): string {
  const msg = utf8ToBytes(text);
  const hash = keccak_256(
    new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]),
  );
  const bytes = hexToBytes(signature.slice(2));
  const v = bytes[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery > 1) throw new Unverified('signature is malformed');
  const pub = secp256k1.Signature.fromCompact(bytes.slice(0, 64))
    .addRecoveryBit(recovery)
    .recoverPublicKey(hash)
    .toRawBytes(false);
  return '0x' + bytesToHex(keccak_256(pub.slice(1)).slice(-20));
}
