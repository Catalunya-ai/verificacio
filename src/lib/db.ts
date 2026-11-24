/**
 * Database connection for every script in this repository.
 *
 * The scripts read ONE environment variable, DATABASE_URL: a standard
 * PostgreSQL connection string that points at YOUR database, for example
 *
 *   export DATABASE_URL=postgres://user:password@localhost:5432/menjometre
 *
 * Nothing else is read: no .env file, no hosted service, no default host.
 * Load the schema first (sql/install.sql), then run the connectors.
 */

import pg from "pg";

/** The connection string, or a clear error when it is missing. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || !url.trim()) {
    throw new Error(
      "DATABASE_URL is not set. Point it at your own PostgreSQL database, e.g. " +
        "postgres://user:password@localhost:5432/menjometre (see README.md)."
    );
  }
  return url.trim();
}

/**
 * The same connection expressed as libpq environment variables (PGHOST,
 * PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE). psql reads them, so the
 * connection string never travels on a command line or into a process list.
 */
export function libpqEnv(url: string = databaseUrl()): Record<string, string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid postgres:// connection string.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must start with postgres:// or postgresql://");
  }

  const env: Record<string, string> = {};
  const host = parsed.searchParams.get("host") || parsed.hostname;
  if (host) env.PGHOST = decodeURIComponent(host);
  if (parsed.port) env.PGPORT = parsed.port;
  if (parsed.username) env.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  const database = parsed.pathname.replace(/^\//, "");
  if (database) env.PGDATABASE = decodeURIComponent(database);
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/** Minimal query interface, satisfied by pg.Pool and pg.Client (and by test fakes). */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** A small connection pool on DATABASE_URL. Call `end()` when the script finishes. */
export function createPool(max = 4): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl(), max });
}
