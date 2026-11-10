import { z } from 'zod';
import type { Brand } from './brand';

/** A NEAR account id. Fungible-token and protocol contracts are accounts too. */
export type AccountId = Brand<string, 'AccountId'>;
export type TokenId = AccountId;

const NAMED_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;

export function isAccountId(value: string): value is AccountId {
  return (
    value.length >= 2 &&
    value.length <= 64 &&
    (NAMED_ACCOUNT.test(value) || IMPLICIT_ACCOUNT.test(value))
  );
}

export function accountId(value: string): AccountId {
  if (!isAccountId(value)) throw new TypeError(`Invalid NEAR account id: ${JSON.stringify(value)}`);
  return value;
}

export const accountIdSchema = z
  .string()
  .refine(isAccountId, { message: 'Invalid NEAR account id' })
  .transform((v): AccountId => v);

/** Unsigned decimal integer string -> bigint. Used for U128 values coming from contracts. */
export const u128StringSchema = z
  .string()
  .regex(/^\d+$/, 'Expected an unsigned integer string')
  .transform((v) => BigInt(v));

export type Network = 'mainnet';
export const networkSchema = z.enum(['mainnet']);

export type ProtocolId = 'rhea' | 'burrow';
