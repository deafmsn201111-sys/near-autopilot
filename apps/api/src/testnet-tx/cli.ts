/**
 * Manually confirmed NEAR TESTNET transactions, within hard limits (model.ts). Usage (from apps/api):
 *
 *   pnpm testnet-tx preview wrap.storage_deposit
 *   pnpm testnet-tx preview wrap.near_deposit --amount 0.01
 *   pnpm testnet-tx send <previewHash> --confirm <previewHash>     # needs TESTNET_SIGNER_KEY_FILE
 *   pnpm testnet-tx status <txHash>
 *   pnpm testnet-tx ledger
 *
 * `preview`, `status` and `ledger` are read-only. Only `send` loads a key, and only after the user repeats the exact
 * preview hash. There is no mainnet path: the RPC must report chain id "testnet" and the account must be *.testnet.
 */
import { randomUUID } from 'node:crypto';
import { accountIdSchema, errorMessage } from '@near-autopilot/core';
import { createDatabase, runMigrations } from '@near-autopilot/db';
import {
  NearKeyPairSigner,
  NearRpcClient,
  NearTransactionBroadcaster,
  SignerConfigurationError,
} from '@near-autopilot/near-adapter';
import { z } from 'zod';
import { RpcTestnetChainReader } from './chain';
import { DrizzleTestnetTxLedger } from './ledger';
import { formatNear, parseNear, TESTNET_TX_LIMITS, type TestnetTxRecord } from './model';
import { isOperationId, OPERATION_IDS } from './operations';
import { TestnetTxRefused, TestnetTxService } from './service';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  TESTNET_ACCOUNT_ID: accountIdSchema.refine((a) => a.endsWith('.testnet'), {
    message: 'must be a *.testnet account',
  }),
  TESTNET_RPC_URL: z.string().url().default('https://rpc.testnet.near.org'),
  /** Optional key for a hosted RPC (e.g. FastNEAR), sent as `Authorization: Bearer`. Never printed. */
  TESTNET_RPC_API_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(8).optional(),
  ),
  /** Only read by `send`. A path OUTSIDE the repository, mode 600. */
  TESTNET_SIGNER_KEY_FILE: z.string().optional(),
  NEAR_NETWORK: z.enum(['testnet']).optional(),
});

const print = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

function show(r: TestnetTxRecord): void {
  const p = r.preview;
  print(`status         ${r.status}${r.error ? ` (${r.error})` : ''}`);
  if (r.status === 'rejected') return;
  print(`network        ${p.network} (RPC chain id "${p.chainId}", block ${p.blockHeight})`);
  print(`signer         ${p.signerId}`);
  print(`contract       ${p.receiverId}`);
  print(`method         ${p.methodName}`);
  print(`arguments      ${JSON.stringify(p.args)}`);
  print(`deposit        ${formatNear(BigInt(p.depositYocto))} NEAR`);
  print(`gas            ${BigInt(p.gas) / 10n ** 12n} Tgas at ${p.gasPriceYocto} yocto/gas`);
  print(`max fee        ${formatNear(BigInt(p.maxFeeYocto))} NEAR`);
  print(
    `max total cost ${formatNear(BigInt(p.maxCostYocto))} NEAR (limit per operation ${formatNear(TESTNET_TX_LIMITS.maxPerOperationYocto)})`,
  );
  print(`available now  ${formatNear(BigInt(p.availableBeforeYocto))} NEAR`);
  print(
    `budget         used ${formatNear(BigInt(p.budget.spentYocto))} of ${formatNear(TESTNET_TX_LIMITS.totalBudgetYocto)} NEAR; at most ${formatNear(BigInt(p.budget.remainingAfterYocto))} left after this`,
  );
  print(`expected       ${p.expectedResult}`);
  for (const risk of p.risks) print(`risk           ${risk}`);
  if (r.txHash)
    print(`tx hash        ${r.txHash}  (https://testnet.nearblocks.io/txns/${r.txHash})`);
  if (r.actualCostYocto !== null) print(`actual cost    ${formatNear(r.actualCostYocto)} NEAR`);
  print(`preview hash   ${r.previewHash}`);
  print(`expires        ${r.expiresAt.toISOString()}`);
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, arg, ...rest] = argv;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const env = envSchema.parse(process.env);
  const accountId = env.TESTNET_ACCOUNT_ID;
  const rpc = new NearRpcClient({
    url: env.TESTNET_RPC_URL,
    headers: env.TESTNET_RPC_API_KEY
      ? { authorization: `Bearer ${env.TESTNET_RPC_API_KEY}` }
      : undefined,
  });
  const database = createDatabase(env.DATABASE_URL, { max: 2 });
  try {
    await runMigrations(database.db);
    const service = new TestnetTxService({
      accountId,
      chain: new RpcTestnetChainReader(rpc),
      ledger: new DrizzleTestnetTxLedger(database.db),
      clock: { now: () => new Date() },
      ids: { next: () => randomUUID() },
    });

    switch (command) {
      case 'preview': {
        if (!arg || !isOperationId(arg)) {
          print(`operation must be one of: ${OPERATION_IDS.join(', ')}`);
          return 2;
        }
        const amount = flag('--amount');
        const record = await service.prepare(
          arg,
          amount === undefined ? {} : { amountYocto: parseNear(amount) },
        );
        show(record);
        if (record.status === 'prepared') {
          print();
          print('Nothing has been signed or sent. To send exactly this, within 10 minutes:');
          print(`  pnpm testnet-tx send ${record.previewHash} --confirm ${record.previewHash}`);
        }
        return record.status === 'prepared' ? 0 : 1;
      }
      case 'send': {
        if (!arg) {
          print('usage: send <previewHash> --confirm <previewHash>');
          return 2;
        }
        if (!env.TESTNET_SIGNER_KEY_FILE) {
          print(
            'TESTNET_SIGNER_KEY_FILE is not set: no signer, nothing sent (see docs/testnet-transactions.md).',
          );
          return 2;
        }
        const signer = NearKeyPairSigner.fromKeyFile(env.TESTNET_SIGNER_KEY_FILE, accountId);
        const record = await service.send(
          arg,
          flag('--confirm') ?? '',
          signer,
          new NearTransactionBroadcaster(rpc),
        );
        show(record);
        return record.status === 'confirmed' ? 0 : 1;
      }
      case 'status': {
        if (!arg) {
          print('usage: status <txHash>');
          return 2;
        }
        show(await service.reconcile(arg));
        return 0;
      }
      case 'ledger': {
        const view = await service.ledgerView();
        print(
          `budget used ${formatNear(view.spentYocto)} of ${formatNear(TESTNET_TX_LIMITS.totalBudgetYocto)} NEAR, ${formatNear(view.remainingYocto)} left`,
        );
        for (const r of view.records) {
          print(
            `${r.createdAt.toISOString()}  ${r.status.padEnd(9)} ${r.operation.padEnd(21)} max ${formatNear(r.maxCostYocto)}  actual ${r.actualCostYocto === null ? '-' : formatNear(r.actualCostYocto)}  ${r.txHash ?? r.previewHash.slice(0, 16)}${r.error ? `  ${r.error}` : ''}`,
          );
        }
        return 0;
      }
      default:
        print(
          'commands: preview <operation> [--amount NEAR] | send <hash> --confirm <hash> | status <txHash> | ledger',
        );
        return 2;
    }
  } finally {
    await database.close();
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const known = error instanceof TestnetTxRefused || error instanceof SignerConfigurationError;
    process.stderr.write(`${known ? 'refused' : 'error'}: ${errorMessage(error)}\n`);
    process.exit(1);
  });
