import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export function createDatabase(
  connectionString: string,
  options: { max?: number } = {},
): DatabaseHandle {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10, idleTimeoutMillis: 30_000 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
