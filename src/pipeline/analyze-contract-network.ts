/**
 * Contract Network Analysis
 *
 * Analyzes contracts for:
 * 1. Sole-source detection (num_bidders = 1, Contracte menor, Negociat sense publicitat)
 * 2. Contract fragmentation (amounts clustering just below 15K threshold)
 * 3. Shared funder connections (same org gives grants AND contracts to entity)
 *
 * Usage: npx tsx src/pipeline/analyze-contract-network.ts [--dry-run]
 *   (connection: DATABASE_URL, see src/lib/db.ts)
 */

import { createPsqlRunner, lastLine } from "../lib/psql-runner";
// The band and the minimum contract count come from the scoring config so the
// script and the published methodology can never drift apart.
import {
  FRAGMENTATION_BAND_MAX_EUR,
  FRAGMENTATION_BAND_MIN_EUR,
  FRAGMENTATION_MIN_CONTRACTS,
} from "../lib/scoring-config";

const { runSQL: runPsqlSQL } = createPsqlRunner();

// As in aggregate-stats: the UPDATEs that scan the whole contracts table can
// exceed a short statement_timeout. Configurable like the other two pipeline steps.
const STATEMENT_TIMEOUT = process.env.NETWORK_STATEMENT_TIMEOUT || "3600s";

function runSQL(label: string, sql: string): string {
  const timeoutPrefix = `SET statement_timeout = '${STATEMENT_TIMEOUT}';\n`;
  const output = runPsqlSQL(timeoutPrefix + sql).trim();
  console.log(`  ${label}: ${output || "done"}`);
  return output;
}

function countRows(label: string, sql: string): number {
  // Same reason as in aggregate-stats: the SET prefix leaves its command tag
  // before the number.
  const output = runSQL(label, sql);
  const raw = lastLine(output);
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${label} ha retornat un recompte invalid: ${JSON.stringify(raw)} (sortida: ${JSON.stringify(output.slice(0, 200))})`);
  }
  return Number.parseInt(raw, 10);
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");

  console.log("=== Contract Network Analysis ===\n");

  // Check contracts exist
  const count = countRows("Contract count", "SELECT COUNT(*) FROM contracts WHERE superseded IS NOT TRUE");
  if (count === 0) {
    console.log("No contracts found. Run sync-contractes.ts first.");
    return;
  }
  console.log(`  Analyzing ${count.toLocaleString()} contracts\n`);

  // 1. Sole-source analysis
  console.log("Step 1: Sole-source analysis (num_bidders = 1 OR Contracte menor OR Negociat sense publicitat)...");

  if (!isDryRun) {
    // Ensure columns exist
    runSQL("Add sole_source columns", `
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS sole_source_count INTEGER DEFAULT 0;
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS sole_source_amount DECIMAL(15,2) DEFAULT 0;
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS sole_source_pct DECIMAL(5,2) DEFAULT 0;
    `);

    // Entities that lost their last active contract are absent from ss below.
    // Clear their previous network fields before updating entities that still have contracts.
    runSQL("Clear sole-source stats without contracts", `
      UPDATE entities SET sole_source_count = 0, sole_source_amount = 0, sole_source_pct = 0
      WHERE COALESCE(total_contracts, 0) = 0
        AND (COALESCE(sole_source_count, 0) > 0
          OR COALESCE(sole_source_amount, 0) > 0
          OR COALESCE(sole_source_pct, 0) > 0);
    `);

    runSQL("Update sole-source stats", `
      WITH ss AS (
        SELECT entity_id,
          COUNT(*) FILTER (WHERE num_bidders = 1 OR procedure_type = 'Contracte menor' OR procedure_type = 'Negociat sense publicitat') AS ss_count,
          COALESCE(SUM(amount) FILTER (WHERE num_bidders = 1 OR procedure_type = 'Contracte menor' OR procedure_type = 'Negociat sense publicitat'), 0) AS ss_amount,
          COUNT(*) AS total_contracts
        FROM contracts
        WHERE superseded IS NOT TRUE AND entity_id IS NOT NULL
        GROUP BY entity_id
      )
      UPDATE entities e SET
        sole_source_count = ss.ss_count,
        sole_source_amount = ss.ss_amount,
        sole_source_pct = CASE WHEN ss.total_contracts > 0
          THEN ROUND(ss.ss_count::DECIMAL / ss.total_contracts * 100, 2)
          ELSE 0 END
      FROM ss WHERE e.id = ss.entity_id;
    `);
  }

  // Stats
  countRows("Entities with sole-source contracts",
    "SELECT COUNT(*) FROM entities WHERE sole_source_count > 0");
  const staleSoleSource = countRows("Entities without contracts with stale sole-source stats",
    "SELECT COUNT(*) FROM entities WHERE COALESCE(total_contracts, 0) = 0 AND (COALESCE(sole_source_count, 0) > 0 OR COALESCE(sole_source_amount, 0) > 0 OR COALESCE(sole_source_pct, 0) > 0)");
  if (staleSoleSource > 0) {
    throw new Error(`${staleSoleSource} entities have sole-source stats but no active contracts`);
  }
  // COALESCE because sole_source_amount is nullable: a NULL would make the
  // whole concatenation NULL and the row would vanish from the log silently.
  runSQL("Top sole-source by amount",
    "SELECT name || ' (' || COALESCE(sole_source_amount::TEXT, 'import desconegut') || ')' FROM entities WHERE sole_source_count > 0 ORDER BY sole_source_amount DESC NULLS LAST LIMIT 5");

  // 2. Fragmentation analysis
  console.log("\nStep 2: Fragmentation analysis (14.9K-15K threshold)...");

  if (!isDryRun) {
    runSQL("Add fragmentation columns", `
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS fragmentation_risk DECIMAL(5,2) DEFAULT 0;
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS fragmentation_count INTEGER DEFAULT 0;
    `);

    // Reset stale fragmentation values before recalculating
    runSQL("Reset fragmentation values", `
      UPDATE entities SET fragmentation_count = 0, fragmentation_risk = 0
      WHERE fragmentation_count > 0;
    `);

    // Detect contracts just below the 15K competitive bidding threshold
    // fragmentation_risk = portfolio-wide % of near-threshold contracts (not per-organ MAX)
    runSQL("Update fragmentation risk", `
      WITH entity_totals AS (
        SELECT entity_id,
          COUNT(*) FILTER (WHERE amount >= ${FRAGMENTATION_BAND_MIN_EUR} AND amount < ${FRAGMENTATION_BAND_MAX_EUR}) AS near_threshold,
          COUNT(*) AS total
        FROM contracts
        WHERE superseded IS NOT TRUE AND entity_id IS NOT NULL
        GROUP BY entity_id
        HAVING COUNT(*) FILTER (WHERE amount >= ${FRAGMENTATION_BAND_MIN_EUR} AND amount < ${FRAGMENTATION_BAND_MAX_EUR}) >= ${FRAGMENTATION_MIN_CONTRACTS}
      )
      UPDATE entities e SET
        fragmentation_count = et.near_threshold,
        fragmentation_risk = ROUND(et.near_threshold::DECIMAL / GREATEST(et.total, 1) * 100, 2)
      FROM entity_totals et WHERE e.id = et.entity_id;
    `);
  }

  countRows("Entities with fragmentation risk",
    "SELECT COUNT(*) FROM entities WHERE fragmentation_count > 0");

  // 3. Shared funder connections
  console.log("\nStep 3: Shared funder connections (grants + contracts from same body)...");

  if (!isDryRun) {
    runSQL("Insert shared_funder connections", `
      WITH grant_depts AS (
        SELECT entity_id, department AS funder
        FROM grants
        WHERE superseded IS NOT TRUE AND department IS NOT NULL AND entity_id IS NOT NULL
        GROUP BY entity_id, department
      ),
      contract_organs AS (
        SELECT entity_id, organ AS funder
        FROM contracts
        WHERE superseded IS NOT TRUE AND organ IS NOT NULL AND entity_id IS NOT NULL
        GROUP BY entity_id, organ
      ),
      shared AS (
        SELECT DISTINCT g.entity_id, g.funder
        FROM grant_depts g
        JOIN contract_organs c ON g.entity_id = c.entity_id
          AND (g.funder ILIKE '%' || c.funder || '%' OR c.funder ILIKE '%' || g.funder || '%')
      )
      INSERT INTO entity_connections (entity_id, related_entity_id, connection_type, detail, strength)
      SELECT s.entity_id, s.entity_id, 'shared_funder', s.funder, 50
      FROM shared s
      WHERE NOT EXISTS (
        SELECT 1 FROM entity_connections ec
        WHERE ec.entity_id = s.entity_id AND ec.connection_type = 'shared_funder' AND ec.detail = s.funder
      )
      LIMIT 10000;
    `);
  }

  countRows("Shared funder connections",
    "SELECT COUNT(*) FROM entity_connections WHERE connection_type = 'shared_funder'");

  // 4. Repeated sole-source from same organ
  console.log("\nStep 4: Repeated sole-source detection...");

  if (!isDryRun) {
    runSQL("Insert sole_source_repeat connections", `
      WITH repeats AS (
        SELECT entity_id, organ, COUNT(*) AS cnt, SUM(amount) AS total
        FROM contracts
        WHERE superseded IS NOT TRUE AND num_bidders = 1 AND organ IS NOT NULL AND entity_id IS NOT NULL
        GROUP BY entity_id, organ
        HAVING COUNT(*) >= 3
      )
      INSERT INTO entity_connections (entity_id, related_entity_id, connection_type, detail, strength)
      SELECT r.entity_id, r.entity_id, 'sole_source_repeat',
        -- amount es nullable: si TOTS els imports del grup son NULL, SUM() torna
        -- NULL i tota la concatenacio es fa NULL, cosa que viola el NOT NULL de
        -- detail. Ho diem, no ho inventem: un 0 aqui es llegiria com "aquest
        -- organ hi va adjudicar zero euros", que es una xifra que no tenim.
        r.organ || ' (' || r.cnt || 'x, ' ||
          CASE WHEN r.total IS NULL THEN 'import desconegut'
               ELSE ROUND(r.total::DECIMAL, 0) || ' EUR' END || ')',
        LEAST(r.cnt * 10, 100)
      FROM repeats r
      WHERE NOT EXISTS (
        SELECT 1 FROM entity_connections ec
        WHERE ec.entity_id = r.entity_id AND ec.connection_type = 'sole_source_repeat' AND ec.detail LIKE r.organ || '%'
      )
      LIMIT 50000;
    `);
  }

  countRows("Sole-source repeat connections",
    "SELECT COUNT(*) FROM entity_connections WHERE connection_type = 'sole_source_repeat'");

  console.log("\n=== Network Analysis Complete ===");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
