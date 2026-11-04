import { loadDatabaseEnv } from '@near-autopilot/config';
import { createDatabase } from './client';
import { runMigrations } from './migrate';

const { DATABASE_URL } = loadDatabaseEnv();
const handle = createDatabase(DATABASE_URL, { max: 1 });
try {
  await runMigrations(handle.db);
  console.log('migrations applied');
} finally {
  await handle.close();
}
