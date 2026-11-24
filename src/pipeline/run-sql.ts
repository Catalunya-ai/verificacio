/**
 * Runs one SQL file against DATABASE_URL with psql (ON_ERROR_STOP=1), from
 * the repository root, so `\i sql/...` includes resolve.
 *
 * Usage:
 *   npx tsx src/pipeline/run-sql.ts sql/install.sql
 *   npx tsx src/pipeline/run-sql.ts sql/pipeline/020-reconcile-entity-stubs.sql --single-transaction
 *   npx tsx src/pipeline/run-sql.ts sql/queries/02-fitxa-entitat.sql id=G12345678
 *
 * --single-transaction wraps the whole file in BEGIN ... COMMIT (what `psql -1`
 * does for a file): any error rolls everything back.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPsqlRunner } from "../lib/psql-runner";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npx tsx src/pipeline/run-sql.ts <file.sql> [--single-transaction] [NAME=value ...]");
  process.exit(2);
}

const root = resolve(__dirname, "..", "..");
if (process.cwd() !== root) {
  console.error(`Run it from the repository root (${root}): the \\i paths of the SQL files are relative to it.`);
  process.exit(2);
}

const rest = process.argv.slice(3);
const singleTransaction = rest.includes("--single-transaction");

// Psql variables can be passed as NAME=value after the file, e.g. id=G12345678.
const variables = rest
  .filter((arg) => arg !== "--single-transaction")
  .map((pair) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(pair);
    if (!m) throw new Error(`Variables go as NAME=value, got ${JSON.stringify(pair)}`);
    return `\\set ${m[1]} '${m[2].replace(/'/g, "''")}'`;
  });

const body = readFileSync(resolve(root, file), "utf8");
const sql = [...variables, ...(singleTransaction ? ["BEGIN;", body, "COMMIT;"] : [body])].join("\n");
const output = createPsqlRunner().runSQLFile(sql);
if (output) console.log(output);
