import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { Env } from '../config/env.js';
import type { Logger } from '../lib/logger.js';
import * as schema from './schema.js';

export type RippleDb = ReturnType<typeof createDb>['db'];

export function createDb(env: Pick<Env, 'DATABASE_PATH'>, logger: Logger) {
  const resolved = path.resolve(env.DATABASE_PATH);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const sqlite = new Database(resolved);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  // Negative cache_size is KiB; -2000 ≈ 2 MiB page cache — Pi-friendly.
  sqlite.pragma('cache_size = -2000');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  logger.info({ path: resolved }, 'sqlite opened');

  return { db, sqlite };
}
