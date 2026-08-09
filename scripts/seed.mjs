// Cross-platform runner for scripts/seed.sql.
//
// `psql "$DATABASE_URL" -f scripts/seed.sql` only works in POSIX shells - on
// Windows cmd.exe (pnpm's default shell there) `$DATABASE_URL` is never
// expanded, so psql receives the literal string and mis-parses the rest of
// the argument list. Spawning psql directly with an explicit argv avoids
// shell quoting/expansion entirely, so this behaves the same on every OS.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedFile = path.join(here, 'seed.sql');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set (checked process.env and .env in the repo root).');
  process.exit(1);
}

const result = spawnSync('psql', ['-d', databaseUrl, '-f', seedFile], { stdio: 'inherit' });

if (result.error) {
  if (result.error.code === 'ENOENT') {
    console.error('psql was not found on PATH. Install the PostgreSQL client tools and retry.');
  } else {
    console.error(result.error.message);
  }
  process.exit(1);
}

process.exit(result.status ?? 1);
