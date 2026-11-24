/**
 * Quick overview of the database after a load: row counts and the top 10
 * entities by Menjòmetre score with their five components.
 *
 * Usage: npx tsx src/pipeline/verify-stats.ts
 *   (connection: DATABASE_URL, see src/lib/db.ts)
 */

import { createPool } from "../lib/db";

const db = createPool(1);

async function count(label: string, sql: string): Promise<number> {
  try {
    const { rows } = await db.query<{ n: string }>(sql);
    return Number(rows[0]?.n ?? 0);
  } catch (error) {
    throw new Error(`verify-stats: ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const fmt = (value: unknown, digits = 0) =>
  value === null || value === undefined ? "–" : Number(value).toFixed(digits);

async function main() {
  const totalEntities = await count("total entities", "SELECT COUNT(*) AS n FROM entities");
  const scoredEntities = await count("scored entities", "SELECT COUNT(*) AS n FROM entities WHERE menjometre_score > 0");
  const totalGrants = await count("total grants", "SELECT COUNT(*) AS n FROM grants");
  const raiscGrants = await count("RAISC grants", "SELECT COUNT(*) AS n FROM grants WHERE source_dataset = 'raisc_concessions'");
  const activeGrants = await count("active grants", "SELECT COUNT(*) AS n FROM grants WHERE superseded IS NOT TRUE");
  const withCif = await count("entities with CIF", "SELECT COUNT(*) AS n FROM entities WHERE cif IS NOT NULL");
  const yearlyStats = await count("yearly stats", "SELECT COUNT(*) AS n FROM entity_yearly_stats");
  const totalBudgetTransfers = await count("budget transfers", "SELECT COUNT(*) AS n FROM budget_transfers");
  const matchedBudgetTransfers = await count("matched budget transfers", "SELECT COUNT(*) AS n FROM budget_transfers WHERE entity_id IS NOT NULL");
  const totalContracts = await count("contracts", "SELECT COUNT(*) AS n FROM contracts");
  const activeContracts = await count("active contracts", "SELECT COUNT(*) AS n FROM contracts WHERE superseded IS NOT TRUE");

  const { rows: top10 } = await db.query(
    `SELECT name, cif, menjometre_score, score_volume, score_frequency, score_dominance,
            score_concurrencia, score_accountability, total_public_funds, total_grants, total_contracts
     FROM entities
     WHERE menjometre_score > 0
     ORDER BY menjometre_score DESC
     LIMIT 10`
  );

  console.log("=== DATABASE STATS ===");
  console.log("Total entities:", totalEntities.toLocaleString());
  console.log("Scored entities (score > 0):", scoredEntities.toLocaleString());
  console.log("Total grants:", totalGrants.toLocaleString());
  console.log("  RAISC grants:", raiscGrants.toLocaleString());
  console.log("  Active (not superseded):", activeGrants.toLocaleString());
  console.log("Entities with CIF:", withCif.toLocaleString());
  console.log("Yearly stats:", yearlyStats.toLocaleString());
  console.log(`Contracts: ${totalContracts.toLocaleString()} (${activeContracts.toLocaleString()} active)`);
  console.log(`Budget transfers: ${totalBudgetTransfers.toLocaleString()} total, ${matchedBudgetTransfers.toLocaleString()} matched (${totalBudgetTransfers ? ((matchedBudgetTransfers / totalBudgetTransfers) * 100).toFixed(1) : 0}%)`);

  console.log("\n=== TOP 10 BY MENJOMETRE SCORE ===");
  console.log("  score | name | public funds | grants | contracts | V F D C A");
  for (const e of top10) {
    const amt = Number(e.total_public_funds).toLocaleString("es-ES", { maximumFractionDigits: 0 });
    console.log(
      `  ${fmt(e.menjometre_score, 1)} | ${e.name} | ${amt} EUR | ${e.total_grants} | ${e.total_contracts} | ` +
        `V:${fmt(e.score_volume)} F:${fmt(e.score_frequency)} D:${fmt(e.score_dominance)} C:${fmt(e.score_concurrencia)} A:${fmt(e.score_accountability)}`
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => db.end());
