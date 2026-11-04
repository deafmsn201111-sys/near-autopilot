import { readFileSync } from 'node:fs';
import { accountIdSchema, type AccountId } from '@near-autopilot/core';
import { guardianConfigSchema, rebalancerConfigSchema } from '@near-autopilot/agents';
import { policyConfigSchema } from '@near-autopilot/policy-engine';
import { z } from 'zod';

export const autopilotConfigSchema = z
  .object({
    policy: policyConfigSchema,
    guardian: guardianConfigSchema,
    /** Optional; the rebalancer is only registered when configured and enabled. */
    rebalancer: rebalancerConfigSchema.optional(),
    rhea: z
      .object({
        /** Reviewed pools the quoter may use. Empty means no swaps can be quoted. */
        pools: z
          .array(
            z
              .object({
                poolId: z.number().int().nonnegative(),
                tokenA: accountIdSchema,
                tokenB: accountIdSchema,
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .default({ pools: [] }),
  })
  .strict();

export type AutopilotConfig = z.output<typeof autopilotConfigSchema>;

export function parseAutopilotConfig(json: unknown, expectedSigner: AccountId): AutopilotConfig {
  const parsed = autopilotConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid autopilot config:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  }
  if (parsed.data.policy.signerAccountId !== expectedSigner) {
    throw new Error(
      `policy.signerAccountId (${parsed.data.policy.signerAccountId}) must equal AUTOPILOT_ACCOUNT_ID (${expectedSigner})`,
    );
  }
  return parsed.data;
}

export function loadAutopilotConfig(path: string, expectedSigner: AccountId): AutopilotConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `Cannot read autopilot config at ${path}. Copy config/autopilot.example.json and edit it.`,
      { cause },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Autopilot config at ${path} is not valid JSON`, { cause });
  }
  return parseAutopilotConfig(json, expectedSigner);
}
