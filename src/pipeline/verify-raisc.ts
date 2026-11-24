/**
 * Post-RAISC import verification script.
 *
 * Checks row counts, dedup integrity, geographic coverage,
 * superseded counts, and score distribution.
 *
 * Usage: npx tsx src/pipeline/verify-raisc.ts
 *   (connection: DATABASE_URL, see src/lib/db.ts)
 */

import { createPool } from "../lib/db";

const db = createPool(1);

async function count(label: string, sql: string, params: unknown[] = []): Promise<number> {
  try {
    const { rows } = await db.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  console.log("=== RAISC Import Verification ===\n");

  // 1. Row counts by source_dataset
  console.log("1. Grant counts by source_dataset:");
  const totalGrants = await count("total grants count", "SELECT COUNT(*) AS n FROM grants");
  const { rows: bySource } = await db.query<{ source_dataset: string | null; n: string }>(
    "SELECT source_dataset, COUNT(*) AS n FROM grants GROUP BY source_dataset ORDER BY 2 DESC"
  );
  console.log(`  Total:  ${totalGrants.toLocaleString()}`);
  for (const r of bySource) {
    console.log(`  ${r.source_dataset ?? "(null)"}: ${Number(r.n).toLocaleString()}`);
  }

  // 2. Entity counts
  console.log("\n2. Entity counts:");
  const totalEntities = await count("total entities count", "SELECT COUNT(*) AS n FROM entities");
  const scoredEntities = await count("scored entities count", "SELECT COUNT(*) AS n FROM entities WHERE menjometre_score > 0");
  const withCif = await count("entities with CIF count", "SELECT COUNT(*) AS n FROM entities WHERE cif IS NOT NULL");

  console.log(`  Total:   ${totalEntities.toLocaleString()}`);
  console.log(`  Scored:  ${scoredEntities.toLocaleString()}`);
  console.log(`  With CIF: ${withCif.toLocaleString()}`);

  // 3. Dedup verification
  console.log("\n3. RAISC dedup verification:");
  const raiscTotal = await count("RAISC grants with raisc_clau count", "SELECT COUNT(*) AS n FROM grants WHERE raisc_clau IS NOT NULL");
  const raiscDistinct = await count("RAISC distinct raisc_clau count", "SELECT COUNT(DISTINCT raisc_clau) AS n FROM grants WHERE raisc_clau IS NOT NULL");

  console.log(`  Grants with raisc_clau: ${raiscTotal.toLocaleString()}`);
  console.log(`  Distinct raisc_clau:    ${raiscDistinct.toLocaleString()} (UNIQUE index idx_grants_raisc_clau)`);

  // 4. Geographic coverage
  console.log("\n4. Geographic coverage:");
  const withComarca = await count("entities with comarca count", "SELECT COUNT(*) AS n FROM entities WHERE comarca IS NOT NULL");
  const withComarcaCode = await count("entities with comarca_code count", "SELECT COUNT(*) AS n FROM entities WHERE comarca_code IS NOT NULL");

  console.log(`  Entities with comarca:      ${withComarca.toLocaleString()}`);
  console.log(`  Entities with comarca_code: ${withComarcaCode.toLocaleString()}`);

  // 5. Superseded count
  console.log("\n5. Superseded records:");
  const superseded = await count("superseded grants count", "SELECT COUNT(*) AS n FROM grants WHERE superseded = true");
  const activeGrants = await count("active grants count", "SELECT COUNT(*) AS n FROM grants WHERE superseded IS NOT TRUE");

  console.log(`  Superseded: ${superseded.toLocaleString()}`);
  console.log(`  Active:     ${activeGrants.toLocaleString()}`);

  // 6. Top 10 entities by total_amount
  console.log("\n6. Top 10 entities by total_amount:");
  const { rows: top10 } = await db.query(
    "SELECT name, cif, total_amount, total_grants, menjometre_score FROM entities ORDER BY total_amount DESC NULLS LAST LIMIT 10"
  );

  for (const e of top10) {
    const amt = Number(e.total_amount).toLocaleString("es-ES", {
      maximumFractionDigits: 0,
    });
    console.log(
      `  ${amt} EUR | ${e.total_grants} grants | score ${Number(e.menjometre_score).toFixed(1)} | ${e.name} | ${e.cif || "no-cif"}`
    );
  }

  // 7. Score distribution (the published bands)
  console.log("\n7. Score distribution:");
  const buckets = [
    { label: "0 (no puntuada)", min: 0, max: 0 },
    { label: "0-25 (Baix)", min: 0, max: 25 },
    { label: "26-50 (Moderat)", min: 25, max: 50 },
    { label: "51-75 (Alt)", min: 50, max: 75 },
    { label: "76-100 (Molt alt)", min: 75, max: 100 },
  ];

  for (const bucket of buckets) {
    const n = bucket.max === 0
      ? await count(`score bucket ${bucket.label} count`, "SELECT COUNT(*) AS n FROM entities WHERE menjometre_score = 0")
      : await count(
          `score bucket ${bucket.label} count`,
          "SELECT COUNT(*) AS n FROM entities WHERE menjometre_score > $1 AND menjometre_score <= $2",
          [bucket.min, bucket.max]
        );
    console.log(`  ${bucket.label}: ${n.toLocaleString()}`);
  }

  // 8. Beneficiary type distribution
  console.log("\n8. Beneficiary type codes in grants:");
  for (const code of ["JSA", "FSA", "PFA", "GRA"]) {
    const n = await count(
      `beneficiary type ${code} count`,
      "SELECT COUNT(*) AS n FROM grants WHERE beneficiary_type_code = $1 AND source_dataset = 'raisc_concessions'",
      [code]
    );
    console.log(`  ${code}: ${n.toLocaleString()}`);
  }

  console.log("\n=== Verification Complete ===");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => db.end());
