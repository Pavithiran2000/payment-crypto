import { config as loadEnv } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Anchored to the repo root, not cwd: this script is run from several
// directories and a silently-unloaded .env reads as "DATABASE_URL is not set".
loadEnv({ path: resolve(here, '../../../.env') });

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: resolve(here, '../migrations'),
    });
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
