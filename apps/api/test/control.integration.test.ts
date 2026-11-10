import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, sql, type DatabaseHandle } from '@near-autopilot/db';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';
import { ControlService } from '../src/control/service';
import { EvidenceStore } from '../src/evidence/store';
import { PgControlStore } from '../src/infra/orchestrator-stores';

/** The dashboard's operator controls on a real PostgreSQL: audited, idempotent, never a silent success. */
const adminUrl = process.env['DATABASE_TEST_URL'];
const TOKEN = 'control-token-control-token-control-tok';
const auth = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date('2026-11-07T12:00:00Z');
const clock = { now: () => NOW };

describe.skipIf(!adminUrl)('operator controls (PostgreSQL)', () => {
  const dbName = `autopilot_control_${randomBytes(6).toString('hex')}`;
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

  const api = (fetchImpl?: typeof fetch) =>
    buildAnalyticsServer({
      apiToken: TOKEN,
      store: {} as unknown as CollectorStore,
      intervalSeconds: 900,
      control: new ControlService(handle.db, clock),
      collectorUrl: 'http://collector.internal:4100',
      ...(fetchImpl ? { fetchImpl } : {}),
    });

  it('pause and resume are audited, idempotent, and need an actor and a reason', async () => {
    const app = api();
    const body = { by: 'operator@test', reason: 'maintenance window' };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/control/collector/pause',
          headers: auth,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/control/collector/pause',
          headers: auth,
          payload: body,
        })
      ).json(),
    ).toEqual({ changed: true });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/control/collector/pause',
          headers: auth,
          payload: body,
        })
      ).json(),
    ).toEqual({ changed: false });
    const state = (await app.inject({ url: '/v1/control', headers: auth })).json<{
      collector: { paused: boolean; by: string };
    }>();
    expect(state.collector).toMatchObject({ paused: true, by: 'operator@test' });
    await app.inject({
      method: 'POST',
      url: '/v1/control/collector/resume',
      headers: auth,
      payload: body,
    });
    const chain = await new EvidenceStore(handle.db).verify('simulation:mainnet');
    expect(chain).toMatchObject({ ok: true, entries: 2 });
    expect(
      (await app.inject({ method: 'POST', url: '/v1/control/collector/pause', payload: body }))
        .statusCode,
    ).toBe(401);
    await app.close();
  });

  it('read-only on a scope goes through the durable control store; an unknown scope is a 404', async () => {
    const scope = 'simulation:mainnet:demo.near:demo-500';
    await new PgControlStore(handle.db, scope, 'simulation:mainnet', clock).load(); // the scope exists
    const app = api();
    const engage = await app.inject({
      method: 'POST',
      url: '/v1/control/mode',
      headers: auth,
      payload: { scope, mode: 'read_only', by: 'operator@test', reason: 'drill' },
    });
    expect(engage.json()).toMatchObject({ scope, mode: 'read_only' });
    expect(
      (await new PgControlStore(handle.db, scope, 'simulation:mainnet', clock).load()).mode,
    ).toBe('read_only');
    const back = await app.inject({
      method: 'POST',
      url: '/v1/control/mode',
      headers: auth,
      payload: { scope, mode: 'normal', by: 'operator@test', reason: 'drill over' },
    });
    expect(back.json()).toMatchObject({ mode: 'normal' });
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/control/mode',
      headers: auth,
      payload: { scope: 'nope:nope:nope', mode: 'normal', by: 'x', reason: 'try it' },
    });
    expect(unknown.statusCode).toBe(404);
    const modes = (await app.inject({ url: '/v1/control', headers: auth })).json<{
      modes: { scope: string; history: unknown[] }[];
    }>();
    expect(modes.modes.find((m) => m.scope === scope)?.history).toHaveLength(3);
    await app.close();
  });

  it('"run now" is forwarded to the collector with the token, and its answer is passed through', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fake: typeof fetch = async (url, init) => {
      calls.push({
        url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        auth: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({ error: 'a collection cycle is already running' }), {
        status: 409,
      });
    };
    const app = api(fake);
    const r = await app.inject({ method: 'POST', url: '/v1/control/collector/run', headers: auth });
    expect(r.statusCode).toBe(409);
    expect(calls).toEqual([{ url: 'http://collector.internal:4100/run', auth: `Bearer ${TOKEN}` }]);
    await app.close();
  });
});
