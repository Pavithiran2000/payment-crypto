import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let db: Db | undefined;

export function getDb(): Db {
  if (db) return db;
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  pool = new pg.Pool({
    connectionString,
    max: Number(process.env['DB_POOL_MAX'] ?? 10),
    ssl: process.env['DB_SSL'] === 'true' ? { rejectUnauthorized: true } : false,
  });

  db = drizzle(pool, { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}
