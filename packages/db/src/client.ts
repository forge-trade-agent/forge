import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

// NUMERIC -> string (never JS number), INT8 -> string by default in pg; keep them lossless.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);

export function createDb(url: string, opts: { max?: number; applicationName?: string } = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? "sealdesk",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    async ping() {
      try {
        await db.execute(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}

/** Any Drizzle Postgres database with this schema (node-postgres in prod, PGlite in tests). */
export type AnyDb = import("drizzle-orm/pg-core").PgDatabase<import("drizzle-orm/pg-core").PgQueryResultHKT, typeof schema>;
