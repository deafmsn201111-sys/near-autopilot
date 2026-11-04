import { createDatabase } from '@near-autopilot/db';
import { z } from 'zod';
import { CollectorStore } from '../collector/store';
import { buildAnalyticsServer } from './server';

/**
 * Read-only analytics API (Postgres only). It needs no RPC, no price API and no key other than the shared API token;
 * it keeps serving the last stored data when the collector is down.
 */
const env = z
  .object({
    DATABASE_URL: z.string().url(),
    API_TOKEN: z.string().min(32),
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().default(4000),
    SHADOW_CYCLE_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900),
  })
  .parse(process.env);

const database = createDatabase(env.DATABASE_URL, { max: 4 });
const app = buildAnalyticsServer(
  {
    apiToken: env.API_TOKEN,
    store: new CollectorStore(database.db),
    intervalSeconds: env.SHADOW_CYCLE_INTERVAL_SECONDS,
  },
  { logger: true },
);
const stop = async () => {
  await app.close();
  await database.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
await app.listen({ host: env.API_HOST, port: env.API_PORT });
