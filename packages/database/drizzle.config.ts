import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  // Migrations are generated as SQL files and reviewed before they run.
  // `drizzle-kit push` is never used outside local dev: it diffs and applies
  // without a reviewable artifact, which is unacceptable against a ledger.
  strict: true,
  verbose: true,
});
