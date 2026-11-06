import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiEnv } from '@near-autopilot/config';
import { accountId } from '@near-autopilot/core';
import { SilentLogger } from '@near-autopilot/core/testing';
import { createDatabase, runMigrations, sql, type DatabaseHandle } from '@near-autopilot/db';
import { buildAnalyticsServer } from '../src/analytics/server';
import { parseAutopilotConfig } from '../src/autopilot-config';
import type { CollectorStore } from '../src/collector/store';
import { replayVerdict } from '../src/evidence/replay';
import { EvidenceStore } from '../src/evidence/store';
import { DrizzleRepository } from '../src/infra/drizzle-repository';
import { toPolicyDto } from '../src/presenters';
import { buildServer } from '../src/server';
import { wire } from '../src/wiring';

/**
 * END TO END, on a real PostgreSQL (skipped unless DATABASE_TEST_URL is set; CI sets it):
 *   HTTP POST /v1/runs -> snapshot -> agents -> plan -> policy VERDICT (stored first) -> Shadow Gateway (re-checks the
 *   stored verdict, dry-run, ROUTE recorded) -> AUDIT hash chain -> the read APIs the dashboard pages call.
 * The production composition root (wire) and HTTP servers are used as they are; only the NEAR RPC is the in-process
 * simulation mock, and any other network access fails the test.
 */
const adminUrl = process.env['DATABASE_TEST_URL'];
const TOKEN = 'e2e-token-e2e-token-e2e-token-e2e-token';
const ACCOUNT = 'your-account.testnet';
const config = parseAutopilotConfig(
  JSON.parse(
    readFileSync(
      new URL('../../../config/autopilot.testnet.example.json', import.meta.url),
      'utf8',
    ),
  ) as unknown,
  accountId(ACCOUNT),
);
const noNetwork: typeof fetch = async () => {
  throw new Error('network access attempted in the e2e test');
};

describe.skipIf(!adminUrl)(
  'end to end: cycle -> verdict -> gateway -> audit -> dashboard APIs',
  () => {
    const dbName = `autopilot_e2e_${randomBytes(6).toString('hex')}`;
    let admin: DatabaseHandle;
    let handle: DatabaseHandle;

    beforeAll(async () => {
      admin = createDatabase(adminUrl ?? '', { max: 1 });
      await admin.db.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
      const url = new URL(adminUrl ?? '');
      url.pathname = `/${dbName}`;
      handle = createDatabase(url.toString(), { max: 4 });
      await runMigrations(handle.db);
    });
    afterAll(async () => {
      await handle.close();
      await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}"`));
      await admin.close();
    });

    /** The API process as main.ts builds it (simulation, dry-run), on this database. */
    async function apiProcess(engine: 'legacy' | 'orchestrator') {
      const env = loadApiEnv({
        API_TOKEN: TOKEN,
        DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
        AUTOPILOT_ACCOUNT_ID: ACCOUNT,
        NEAR_NETWORK: 'testnet',
        NEAR_RPC_URL: 'https://rpc.must-not-be-contacted.invalid',
        RHEA_CONTRACT_ID: 'ref-finance-101.testnet',
        BURROW_CONTRACT_ID: 'contract.1638481328.burrow.testnet',
        BURROW_ORACLE_ID: 'priceoracle.testnet',
        DATA_SOURCE: 'simulation',
        SIMULATION_PORTFOLIO: 'demo-500',
        AUTOPILOT_ENGINE: engine,
      });
      const provenance = { dataSource: env.DATA_SOURCE, network: env.NEAR_NETWORK } as const;
      const repo = new DrizzleRepository(handle.db, provenance);
      const { cycle, snapshots, policy } = await wire(env, config, repo, new SilentLogger(), {
        fetchImpl: noNetwork,
        marketFetchImpl: noNetwork,
        mainnetFetchImpl: noNetwork,
      });
      return buildServer({
        apiToken: TOKEN,
        repo,
        snapshots,
        cycle,
        policy: toPolicyDto(policy.config, config.guardian, {
          ...provenance,
          executionMode: env.EXECUTION_MODE,
          engine: env.AUTOPILOT_ENGINE,
          simulationPortfolio: env.SIMULATION_PORTFOLIO,
          marketData: env.MARKET_DATA,
        }),
        provenance,
        evidence: new EvidenceStore(handle.db),
      });
    }
    const auth = { authorization: `Bearer ${TOKEN}` };

    it.each(['legacy', 'orchestrator'] as const)(
      '%s engine: one HTTP-triggered cycle leaves a replayable ALLOW, a gateway record and an intact audit chain',
      async (engine) => {
        const api = await apiProcess(engine);
        const run = await api.inject({ method: 'POST', url: '/v1/runs', headers: auth });
        expect(run.statusCode).toBe(201);
        const body = run.json<{
          run: { status: string };
          proposals: Array<{ kind: string; status: string; txHash: string | null }>;
        }>();
        expect(body.run.status).toBe('completed');
        expect(body.proposals).toContainEqual(
          expect.objectContaining({ kind: 'lending.repay', status: 'dry_run', txHash: null }),
        );

        // 1. The verdict was stored, with its inputs and config, and replays to the same answer.
        const evidence = new EvidenceStore(handle.db);
        const [stored] = await evidence.verdicts({ limit: 1 });
        expect(stored).toMatchObject({
          verdict: 'ALLOW',
          dataSource: 'simulation',
          network: 'testnet',
        });
        if (!stored) throw new Error('no verdict');
        expect(replayVerdict({ ...stored })).toMatchObject({
          status: 'match',
          verdict: 'ALLOW',
          configFrom: 'row',
        });

        // 2. The Shadow Gateway re-checked exactly that stored verdict and recorded the (single-venue) execution.
        const [route] = await evidence.routes({ limit: 1, origin: 'gateway' });
        expect(route).toMatchObject({
          decisionId: stored.id,
          planHash: stored.planHash,
          outcome: 'not_a_swap',
        });

        // 3. The audit chain holds the cycle and verifies from seq 1.
        const chain = await evidence.verify('simulation:testnet');
        expect(chain.ok).toBe(true);
        expect(chain.entries).toBeGreaterThan(0);

        // 4. What the dashboards read: the autopilot API...
        const verdicts = (await api.inject({ url: '/v1/policy/verdicts', headers: auth })).json<{
          verdicts: Array<{ id: string }>;
        }>();
        expect(verdicts.verdicts[0]?.id).toBe(stored.id);
        expect((await api.inject({ url: '/v1/audit/verify', headers: auth })).json()).toMatchObject(
          { ok: true },
        );
        const routes = (
          await api.inject({ url: '/v1/routes?origin=gateway', headers: auth })
        ).json<{
          routes: Array<{ decisionId: string; executed: boolean }>;
        }>();
        expect(routes.routes[0]).toMatchObject({ decisionId: stored.id, executed: false });
        // ...and the analytics API behind the Policy / Audit / Routes pages, with the row's environment.
        const analytics = buildAnalyticsServer({
          apiToken: TOKEN,
          store: {} as unknown as CollectorStore,
          evidence,
          intervalSeconds: 900,
        });
        const page = (
          await analytics.inject({ url: '/v1/analytics/policy/verdicts', headers: auth })
        ).json<{
          verdicts: Array<{ id: string; environment: string; fixture: boolean; checks: unknown[] }>;
        }>();
        expect(page.verdicts[0]).toMatchObject({
          id: stored.id,
          environment: 'simulation:testnet',
          fixture: false,
        });
        expect(page.verdicts[0]?.checks).toHaveLength(12);
        const audit = (await analytics.inject({ url: '/v1/analytics/audit', headers: auth })).json<{
          chains: Array<{ chain: string; verification: { ok: boolean } }>;
        }>();
        expect(audit.chains.find((c) => c.chain === 'simulation:testnet')?.verification.ok).toBe(
          true,
        );
        await api.close();
      },
    );

    it('a restarted API process continues the same chain; tampering with a stored entry is detected', async () => {
      const evidence = new EvidenceStore(handle.db);
      const before = await evidence.verify('simulation:testnet');
      const api = await apiProcess('legacy'); // a new process: new repository, new wiring
      await api.inject({ method: 'POST', url: '/v1/runs', headers: auth });
      const after = await evidence.verify('simulation:testnet');
      expect(after).toMatchObject({ ok: true });
      expect(after.entries).toBeGreaterThan(before.entries);
      await api.close();

      await handle.db.execute(
        sql`alter table audit_events disable trigger audit_events_append_only`,
      );
      try {
        await handle.db.execute(
          sql`update audit_events set type = 'forged' where chain = 'simulation:testnet' and seq = 2`,
        );
        expect(await evidence.verify('simulation:testnet')).toMatchObject({
          ok: false,
          brokenAt: { seq: 2, kind: 'hash' },
        });
      } finally {
        await handle.db.execute(
          sql`alter table audit_events enable trigger audit_events_append_only`,
        );
      }
    });
  },
);
