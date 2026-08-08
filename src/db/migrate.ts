import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { RippleDb } from './index.js';
import type { Logger } from '../lib/logger.js';

function resolveMigrationsFolder(): string {
  const candidates = [
    path.resolve(process.cwd(), 'drizzle'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? path.resolve(process.cwd(), 'drizzle');
}

export function runMigrations(db: RippleDb, logger: Logger): void {
  const migrationsFolder = resolveMigrationsFolder();
  if (!fs.existsSync(migrationsFolder)) {
    logger.warn({ migrationsFolder }, 'no drizzle migrations folder found; skipping migrate');
    return;
  }
  migrate(db, { migrationsFolder });
  logger.info({ migrationsFolder }, 'sqlite migrations applied');
}

/** CLI entry: `pnpm db:migrate` — requires DATABASE_PATH in env / .env loaded externally. */
async function main(): Promise<void> {
  const { parseEnv } = await import('../config/env.js');
  const { createLogger } = await import('../lib/logger.js');
  const { createDb } = await import('./index.js');

  const env = parseEnv();
  const logger = createLogger(env);
  const { db, sqlite } = createDb(env, logger);
  try {
    runMigrations(db, logger);
  } finally {
    sqlite.close();
  }
}

const isDirect =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
