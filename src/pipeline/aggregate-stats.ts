/**
 * Fast entity stats aggregation — pure SQL.
 *
 * All aggregation runs server-side via psql, on the database in DATABASE_URL.
 * Nothing is streamed to the client.
 *
 * Usage: npx tsx src/pipeline/aggregate-stats.ts
 */

import { aggregateStatsStepLabel } from "../lib/aggregate-stats-steps";
import { createPsqlRunner, lastLine, type PsqlFailure, type RunSQLOpts } from "../lib/psql-runner";

let allowedPsqlFailure: PsqlFailure | undefined;
// Connection: DATABASE_URL (see src/lib/db.ts).
const { runSQL: runPsqlSQL } = createPsqlRunner({
  warnAllowedFailures: false,
  onAllowedFailure: (failure) => {
    allowedPsqlFailure = failure;
  },
});

// On the full dataset (~20M grants) an entity-wide UPDATE can take 10-15 min
// on a modest server. A short cap would cancel statements half-way while the
// run reported success, so every statement gets a generous timeout.
const STATEMENT_TIMEOUT = process.env.AGG_STATEMENT_TIMEOUT || "3600s";

/**
 * Runs one SQL statement. THROWS on failure: a silently swallowed error here
 * leaves stale aggregates behind while the run reports success, which is how
 * entity pages ended up showing figures from a previous run.
 * Pass `allowFailure` only where a failure is a real control-flow signal
 * (the CONCURRENTLY -> blocking matview refresh fallback).
 */
function runSQL(label: string, sql: string, opts: RunSQLOpts = {}) {
  const start = Date.now();
  const timeoutPrefix = `SET statement_timeout = '${STATEMENT_TIMEOUT}';\n`;
  allowedPsqlFailure = undefined;
  try {
    const output = runPsqlSQL(timeoutPrefix + sql, opts);
    const ms = Date.now() - start;
    if (allowedPsqlFailure) {
      console.warn(`  ${label}: no aplicable (${ms}ms), s'usa la via alternativa`);
      return "";
    }
    console.log(`  ${label} (${ms}ms)${output ? " → " + output : ""}`);
    return output;
  } catch (e: unknown) {
    const ms = Date.now() - start;
    const stderr = e instanceof Error ? e.message : String(e);
    const isTimeout = /statement timeout|canceling statement/i.test(stderr);
    console.error(`\n  ERROR: ${label} failed (${ms}ms): ${stderr.substring(0, 600)}`);
    if (isTimeout) {
      console.error(`  The limit was ${STATEMENT_TIMEOUT}. Raise it with AGG_STATEMENT_TIMEOUT=5400s (the runner's process ceiling is 7200s and statement_timeout must stay below it).`);
    }
    throw new Error(`aggregate-stats: ${label} failed and the aggregates would be left stale`);
  }
}

function countRows(label: string, sql: string): number {
  // runSQL prefixes a SET, and psql prints its tag before the number
  // ("SET\n21442077"): the value is always the last non-empty line.
  const output = runSQL(label, sql);
  const raw = lastLine(output);
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(
      `aggregate-stats: ${label} ha retornat un recompte invalid: ${JSON.stringify(raw)} (sortida: ${JSON.stringify(output.trim().slice(0, 200))})`,
    );
  }
  return Number.parseInt(raw, 10);
}

function assertFinalInvariants() {
  const threshold = 5000;

  console.log(`\n${aggregateStatsStepLabel("final_invariants")}...`);
  const activeContractOrphans = countRows("Invariant: active contract entity_id orphans", `
    SELECT count(*) FROM contracts WHERE entity_id IS NULL AND superseded IS NOT TRUE;
  `);
  const raiscConcessionOrphans = countRows("Invariant: active RAISC concession entity_id orphans", `
    SELECT count(*) FROM grants WHERE source_dataset='raisc_concessions' AND entity_id IS NULL
      AND superseded IS NOT TRUE;
  `);

  console.log(`  Active contracts without entity_id: ${activeContractOrphans.toLocaleString()} (threshold: ${threshold.toLocaleString()}; healthy baseline: ~1,000)`);
  console.log(`  Active RAISC concessions without entity_id: ${raiscConcessionOrphans.toLocaleString()} (threshold: ${threshold.toLocaleString()}; healthy baseline: ~50-550)`);

  const failures: string[] = [];
  if (activeContractOrphans > threshold) {
    failures.push(`contracts active entity_id orphans = ${activeContractOrphans.toLocaleString()}`);
  }
  if (raiscConcessionOrphans > threshold) {
    failures.push(`raisc_concessions active entity_id orphans = ${raiscConcessionOrphans.toLocaleString()}`);
  }
  if (failures.length > 0) {
    console.error("\n=== ENTITY_ID BACKFILL INVARIANT NOT MET ===");
    console.error("Rows without entity_id are left out of every entity total: the backfill did not run or failed.");
    for (const failure of failures) {
      console.error(`  ${failure} exceeds threshold ${threshold.toLocaleString()}`);
    }
    throw new Error("aggregate-stats invariant not met: entity_id orphan count above threshold");
  }
}

function assertRaiscCcaaCodeComplete() {
  const missing = countRows("Guard: active RAISC concessions missing ccaa_code", `
    SELECT count(*) FROM grants
    WHERE source_dataset='raisc_concessions'
      AND ccaa_code IS NULL
      AND superseded IS NOT TRUE;
  `);

  if (missing > 0) {
    // The aggregation treats all RAISC as CAT by source_dataset (same rule as
    // calculate-scores-sql.ts), so a NULL here does not lose rows.
    console.warn(`Info: ${missing.toLocaleString()} RAISC rows without ccaa_code (informational; aggregation does not depend on it).`);
  }
}

function main() {
  console.log("=== Fast Entity Stats Aggregation (pure SQL) ===\n");
  const t0 = Date.now();
  assertRaiscCcaaCodeComplete();

  // Step 1: Grant aggregation — entity totals (excluding ICF credits)
  console.log(`${aggregateStatsStepLabel("grant_totals")}...`);
  runSQL("Update entity grant totals", `
    WITH agg AS (
      SELECT entity_id,
        SUM(amount) AS total_amount,
        COUNT(*) AS total_grants,
        MIN(grant_year) FILTER (WHERE grant_year IS NOT NULL) AS first_grant_year,
        MAX(grant_year) FILTER (WHERE grant_year IS NOT NULL) AS last_grant_year
      FROM grants
      WHERE superseded IS NOT TRUE AND is_credit IS NOT TRUE AND entity_id IS NOT NULL
        AND (source_dataset = 'raisc_concessions' OR ccaa_code = 'CAT')
      GROUP BY entity_id
    )
    UPDATE entities e SET
      total_amount = COALESCE(agg.total_amount, 0),
      total_grants = COALESCE(agg.total_grants, 0),
      first_grant_year = agg.first_grant_year,
      last_grant_year = agg.last_grant_year,
      updated_at = NOW()
    FROM agg WHERE e.id = agg.entity_id;
  `);

  runSQL("Zero out entities with no grants", `
    UPDATE entities SET total_amount = 0, total_grants = 0,
      first_grant_year = NULL, last_grant_year = NULL
    WHERE total_grants > 0
      AND NOT EXISTS (
        -- NOT EXISTS, mai NOT IN: NOT IN amb subconsulta sobre grants (19,5M files)
        -- impedeix l'anti-join i triga desenes de minuts amb la base completa.
        SELECT 1 FROM grants g
        WHERE g.entity_id = entities.id
          AND g.superseded IS NOT TRUE AND g.is_credit IS NOT TRUE
          AND (g.source_dataset = 'raisc_concessions' OR g.ccaa_code = 'CAT')
      );
  `);

  // Step 1b: Credit aggregation — separate totals
  console.log(`\n${aggregateStatsStepLabel("credit_totals")}...`);
  runSQL("Update entity credit totals", `
    WITH credit_agg AS (
      SELECT entity_id,
        SUM(amount) AS total_credit_amount,
        COUNT(*) AS total_credits
      FROM grants
      WHERE is_credit = true AND superseded IS NOT TRUE AND entity_id IS NOT NULL
        AND (source_dataset = 'raisc_concessions' OR ccaa_code = 'CAT')
      GROUP BY entity_id
    )
    UPDATE entities e SET
      total_credit_amount = COALESCE(ca.total_credit_amount, 0),
      total_credits = COALESCE(ca.total_credits, 0),
      updated_at = NOW()
    FROM credit_agg ca WHERE e.id = ca.entity_id;
  `);

  runSQL("Zero out entities with no credits", `
    UPDATE entities SET total_credit_amount = 0, total_credits = 0
    WHERE total_credits > 0
      AND NOT EXISTS (
        SELECT 1 FROM grants g
        WHERE g.entity_id = entities.id
          AND g.is_credit = true AND g.superseded IS NOT TRUE
          AND (g.source_dataset = 'raisc_concessions' OR g.ccaa_code = 'CAT')
      );
  `);

  // Step 2: Grant yearly stats
  // Same filter as step 1, credits excluded: total_amount of a year is the grants
  // WITHOUT the ICF credits (`is_credit IS NOT TRUE`), so the yearly series decomposes
  // the entity total and a row counted here and not there puts the chart above the
  // matview it is supposed to add up to. The credits of a year live apart, in
  // entity_yearly_stats.credit_amount, and readers add them: never subtract them.
  console.log(`\n${aggregateStatsStepLabel("grant_yearly_stats")}...`);
  runSQL("Upsert yearly grant stats", `
    INSERT INTO entity_yearly_stats (entity_id, year, total_amount, grant_count, departments, purposes)
    SELECT g.entity_id, g.grant_year, SUM(g.amount), COUNT(*),
      ARRAY_AGG(DISTINCT g.department) FILTER (WHERE g.department IS NOT NULL),
      ARRAY_AGG(DISTINCT g.purpose) FILTER (WHERE g.purpose IS NOT NULL)
    FROM grants g
    WHERE g.superseded IS NOT TRUE AND g.grant_year IS NOT NULL AND g.entity_id IS NOT NULL
      AND (g.source_dataset = 'raisc_concessions' OR g.ccaa_code = 'CAT')
      AND g.is_credit IS NOT TRUE
    GROUP BY g.entity_id, g.grant_year
    ON CONFLICT (entity_id, year) DO UPDATE SET
      total_amount = EXCLUDED.total_amount,
      grant_count = EXCLUDED.grant_count,
      departments = EXCLUDED.departments,
      purposes = EXCLUDED.purposes;
  `);

  // Step 2b: Zero out stale yearly grant stats for entities with no active grants.
  // Mirror of step 6b, which does the same for contracts. The upsert above can
  // only overwrite years that still have grants: when the last one of an
  // (entity, year) is superseded, nothing rewrites the row and it keeps the
  // amount it had. The NOT EXISTS predicate repeats the upsert's filters on
  // purpose — an anti-join on a different rule than the one that filled the
  // row clears the wrong rows.
  runSQL("Zero stale yearly grant stats", `
    UPDATE entity_yearly_stats eys
    SET total_amount = 0, grant_count = 0
    WHERE eys.total_amount > 0
      AND NOT EXISTS (
        SELECT 1 FROM grants g
        WHERE g.entity_id = eys.entity_id AND g.grant_year = eys.year
          AND g.superseded IS NOT TRUE
          AND g.is_credit IS NOT TRUE
          AND (g.source_dataset = 'raisc_concessions' OR g.ccaa_code = 'CAT')
      );
  `);

  // Step 3: CIF backfill from contracts REMOVED
  // Contract CIFs are unreliable — some organs use their own CIF as GDPR
  // placeholder for person NIFs. Entity CIF should only come from RAISC.
  console.log(`\n${aggregateStatsStepLabel("contract_cif_backfill_skipped")}.`);

  // Step 3b: Dedup alternative-expedient contracts before aggregation
  console.log(`\n${aggregateStatsStepLabel("contract_dedup")}...`);
  // Uses IS NOT DISTINCT FROM for description: NULL=NULL matches, but NULL≠non-NULL does not.
  // Pairs this key misses (the same contract published under two expedients with different
  // descriptions) are recorded in contract_expedient_aliases (curated by hand, or detected by rule
  // right after the sweeps below) and kept superseded by the trigger
  // trg_contracts_enforce_expedient_alias, so this sweep does not need to catch them.
  // Official annulments: contracts stored from an annulment line must not count as awards. The stored
  // decisions (contract_annulment_decisions) are applied before the sweeps read the live rows, and
  // again after the alias detection below. Refreshing the lines and the decisions themselves is the job
  // of the annulment load script: run it after each contracts load.
  runSQL("Official annulment decisions (before the sweeps)", `SELECT rows_superseded, rows_unsuperseded FROM apply_contract_annulments();`);
  // Wrapped in explicit transaction so advisory lock is held during the UPDATE.
  runSQL("Alt-expedient dedup sweep", `
    BEGIN;
    SELECT pg_advisory_xact_lock(hashtext('contract_dedup'));
    WITH deduped AS (
      UPDATE contracts c1
      SET superseded = true
      WHERE c1.superseded IS NOT TRUE
        AND c1.cif IS NOT NULL AND c1.cif != ''
        AND c1.amount > 0
        AND c1.contract_date IS NOT NULL
        AND c1.organ IS NOT NULL AND c1.organ != ''
        AND EXISTS (
          SELECT 1 FROM contracts c2
          WHERE c2.cif = c1.cif
            AND c2.amount = c1.amount
            AND c2.contract_date = c1.contract_date
            AND c2.organ = c1.organ
            AND c2.lot_number = c1.lot_number
            AND c2.description IS NOT DISTINCT FROM c1.description
            AND c2.id < c1.id
            AND c2.superseded IS NOT TRUE
        )
      RETURNING id
    )
    SELECT COUNT(*) FROM deduped;
    COMMIT;
  `);
  runSQL("Empty-lot dedup (CIF)", `
    UPDATE contracts c SET superseded = true
    WHERE c.lot_number = '' AND c.superseded IS NOT TRUE
      AND c.codi_expedient IS NOT NULL AND c.cif IS NOT NULL AND c.cif != ''
      AND EXISTS (
        SELECT 1 FROM contracts c2
        WHERE c2.codi_expedient = c.codi_expedient AND c2.cif = c.cif
          AND c2.lot_number != '' AND c2.superseded IS NOT TRUE
      );
  `);
  runSQL("Empty-lot dedup (slug)", `
    UPDATE contracts c SET superseded = true
    WHERE c.lot_number = '' AND c.superseded IS NOT TRUE
      AND c.codi_expedient IS NOT NULL AND (c.cif IS NULL OR c.cif = '')
      AND EXISTS (
        SELECT 1 FROM contracts c2
        WHERE c2.codi_expedient = c.codi_expedient AND c2.entity_slug = c.entity_slug
          AND c2.lot_number != '' AND c2.superseded IS NOT TRUE
      );
  `);

  // Rule-based expedient aliases: detects the pairs the sweeps above cannot see (same contract
  // under two expedient codes, different descriptions), records the alias and supersedes the copy
  // that has a live canonical twin. After the three sweeps, so it works on the final set of live
  // rows, and before the contract totals below, which must not count the superseded copy.
  const aliasDetect = lastLine(
    runSQL("Rule-based expedient alias detection", `SELECT * FROM detect_contract_expedient_aliases();`)
  );
  const [aliasesAdded, aliasRowsSuperseded] = aliasDetect.split("|");
  console.log(`  → ${aliasesAdded} aliases added, ${aliasRowsSuperseded} contract rows superseded`);

  // The alias detection can set rows live that an annulment decision keeps superseded, and the other
  // way round: apply the decisions again, last, before the contract totals are computed.
  const annulApply = lastLine(
    runSQL("Official annulment decisions", `SELECT rows_superseded, rows_unsuperseded FROM apply_contract_annulments();`)
  );
  const [annulSuperseded, annulLive] = annulApply.split("|");
  console.log(`  → ${annulSuperseded} rows superseded, ${annulLive} rows set live`);

  // Step 3c: Backfilling contract entity_id
  console.log(`\n${aggregateStatsStepLabel("contract_entity_id_backfill")}...`);
  runSQL("Backfill contract entity_id (CIF)", `
    UPDATE contracts c SET entity_id = e.id
    FROM entities e WHERE c.cif = e.cif AND c.entity_id IS NULL AND c.cif IS NOT NULL AND c.cif != '';
  `);
  // Slug fallback only for contracts with no CIF — prevents cross-CIF misattribution
  runSQL("Backfill contract entity_id (slug fallback, no-CIF only)", `
    UPDATE contracts c SET entity_id = e.id
    FROM entities e WHERE c.entity_slug = e.slug AND c.entity_id IS NULL
      AND (c.cif IS NULL OR c.cif = '');
  `);

  // Step 4: Contract aggregation — CIF-first, slug fallback
  console.log(`\n${aggregateStatsStepLabel("contract_totals_via_entity_id")}...`);

  // Reset contract fields before re-aggregating
  runSQL("Reset contract fields", `
    UPDATE entities SET total_contracts = 0, total_contract_amount = 0
    WHERE total_contracts > 0 OR total_contract_amount > 0;
  `);

  runSQL("Contract totals via entity_id", `
    WITH contract_agg AS (
      SELECT entity_id,
        SUM(amount) AS total_contract_amount,
        COUNT(*) AS total_contracts
      FROM contracts
      WHERE superseded IS NOT TRUE AND entity_id IS NOT NULL
      GROUP BY entity_id
    )
    UPDATE entities e SET
      total_contracts = ca.total_contracts,
      total_contract_amount = ca.total_contract_amount,
      updated_at = NOW()
    FROM contract_agg ca WHERE e.id = ca.entity_id;
  `);

  // Step 4b: Conveni aggregation
  console.log(`\n${aggregateStatsStepLabel("conveni_totals")}...`);
  runSQL("Reset conveni fields", `
    UPDATE entities SET total_convenis = 0, total_conveni_amount = 0
    WHERE total_convenis > 0 OR total_conveni_amount > 0;
  `);
  runSQL("Backfill conveni entity_id", `
    UPDATE convenis c SET entity_id = e.id
    FROM entities e WHERE c.entity_slug = e.slug AND c.entity_id IS NULL;
  `);
  runSQL("Conveni totals", `
    WITH conv_agg AS (
      SELECT entity_id,
        COUNT(*) AS total_convenis,
        SUM(COALESCE(amount_total, 0)) AS total_conveni_amount
      FROM convenis WHERE entity_id IS NOT NULL
      GROUP BY entity_id
    )
    UPDATE entities e SET
      total_convenis = ca.total_convenis,
      total_conveni_amount = COALESCE(ca.total_conveni_amount, 0),
      updated_at = NOW()
    FROM conv_agg ca WHERE e.id = ca.entity_id;
  `);

  // Step 4c: Budget transfer aggregation (Cap.4/7 operational transfers)
  console.log(`\n${aggregateStatsStepLabel("budget_transfer_totals")}...`);
  runSQL("Backfill budget_transfers entity_id", `
    UPDATE budget_transfers bt SET entity_id = e.id
    FROM entities e WHERE bt.entity_slug = e.slug AND bt.entity_id IS NULL;
  `);
  runSQL("Operational transfer totals (Cap.4/7) per entity", `
    WITH bt_agg AS (
      SELECT entity_id, SUM(executed_amount) as total_bt
      FROM budget_transfers
      WHERE entity_id IS NOT NULL AND (cap_tol_codi IS NULL OR cap_tol_codi IN (4, 7))
      GROUP BY entity_id
    )
    UPDATE entities e SET
      total_budget_transfers = COALESCE(bt_agg.total_bt, 0),
      updated_at = NOW()
    FROM bt_agg WHERE e.id = bt_agg.entity_id;
  `);

  // Step 4d: Acció concertada aggregation
  console.log(`\n${aggregateStatsStepLabel("accio_concertada_totals")}...`);
  runSQL("Backfill accio_concertada entity_id", `
    UPDATE accio_concertada ac SET entity_id = e.id
    FROM entities e WHERE ac.entity_slug = e.slug AND ac.entity_id IS NULL;
  `);
  runSQL("Acció concertada totals per entity", `
    WITH ac_agg AS (
      SELECT entity_id, SUM(amount) as total_ac
      FROM accio_concertada
      WHERE entity_id IS NOT NULL
      GROUP BY entity_id
    )
    UPDATE entities e SET
      total_accio_concertada = COALESCE(ac_agg.total_ac, 0),
      updated_at = NOW()
    FROM ac_agg WHERE e.id = ac_agg.entity_id;
  `);

  // Step 4e: Equity contribution aggregation (Cap.8 art.87)
  console.log(`\n${aggregateStatsStepLabel("equity_contribution_totals")}...`);
  runSQL("Equity contribution totals per entity", `
    WITH eq_agg AS (
      SELECT entity_id, SUM(executed_amount) as total_eq
      FROM budget_transfers
      WHERE entity_id IS NOT NULL AND cap_tol_codi = 8 AND article_codi = 87
      GROUP BY entity_id
    )
    UPDATE entities e SET
      total_equity_contributions = COALESCE(eq_agg.total_eq, 0),
      updated_at = NOW()
    FROM eq_agg WHERE e.id = eq_agg.entity_id;
  `);

  // Step 5: Compute total_public_funds (grants + contracts + budget transfers + acció concertada + equity — convenis excluded)
  console.log(`\n${aggregateStatsStepLabel("total_public_funds")}...`);
  runSQL("Set total_public_funds", `
    UPDATE entities SET
      total_public_funds = COALESCE(total_amount, 0) + COALESCE(total_contract_amount, 0) + COALESCE(total_budget_transfers, 0) + COALESCE(total_accio_concertada, 0) + COALESCE(total_equity_contributions, 0),
      updated_at = NOW()
    WHERE total_amount > 0 OR total_contract_amount > 0 OR total_budget_transfers > 0 OR total_accio_concertada > 0 OR total_equity_contributions > 0;
  `);
  runSQL("Zero total_public_funds for zero entities", `
    UPDATE entities SET total_public_funds = 0
    WHERE total_public_funds != 0 AND total_amount = 0 AND total_contract_amount = 0 AND total_budget_transfers = 0 AND total_accio_concertada = 0 AND total_equity_contributions = 0;
  `);

  // Step 6: Yearly contract stats — CIF-first
  console.log(`\n${aggregateStatsStepLabel("yearly_contract_stats")}...`);
  runSQL("Insert contract-only yearly rows", `
    WITH yearly_contracts AS (
      SELECT c.entity_id, c.contract_year AS year,
        SUM(c.amount) AS amount, COUNT(*) AS cnt
      FROM contracts c
      WHERE c.superseded IS NOT TRUE AND c.contract_year IS NOT NULL AND c.entity_id IS NOT NULL
      GROUP BY c.entity_id, c.contract_year
    )
    INSERT INTO entity_yearly_stats (entity_id, year, total_amount, grant_count, contract_count, contract_amount, departments, purposes)
    SELECT yc.entity_id, yc.year, 0, 0, yc.cnt, yc.amount, ARRAY[]::text[], ARRAY[]::text[]
    FROM yearly_contracts yc
    WHERE NOT EXISTS (
      SELECT 1 FROM entity_yearly_stats eys WHERE eys.entity_id = yc.entity_id AND eys.year = yc.year
    )
    ON CONFLICT (entity_id, year) DO NOTHING;
  `);

  runSQL("Update yearly contract stats", `
    WITH yearly_contracts AS (
      SELECT c.entity_id, c.contract_year AS year,
        SUM(c.amount) AS amount, COUNT(*) AS cnt
      FROM contracts c
      WHERE c.superseded IS NOT TRUE AND c.contract_year IS NOT NULL AND c.entity_id IS NOT NULL
      GROUP BY c.entity_id, c.contract_year
    )
    UPDATE entity_yearly_stats eys SET
      contract_count = yc.cnt,
      contract_amount = yc.amount
    FROM yearly_contracts yc
    WHERE eys.entity_id = yc.entity_id AND eys.year = yc.year;
  `);

  // Step 6b: Zero out stale yearly contract stats for entities with no active contracts
  runSQL("Zero stale yearly contract stats", `
    UPDATE entity_yearly_stats eys
    SET contract_amount = 0, contract_count = 0
    WHERE eys.contract_amount > 0
      AND NOT EXISTS (
        SELECT 1 FROM contracts c
        WHERE c.entity_id = eys.entity_id AND c.contract_year = eys.year
          AND c.superseded IS NOT TRUE
      );
  `);

  // Step 7: Primary organ and contract type — CIF-first
  console.log(`\n${aggregateStatsStepLabel("primary_contract_fields")}...`);
  runSQL("Primary organ", `
    UPDATE entities e SET primary_organ = sub.organ
    FROM (
      SELECT DISTINCT ON (c.entity_id) c.entity_id, c.organ, COUNT(*) AS cnt
      FROM contracts c
      WHERE c.superseded IS NOT TRUE AND c.organ IS NOT NULL AND c.entity_id IS NOT NULL
      GROUP BY c.entity_id, c.organ
      ORDER BY c.entity_id, cnt DESC
    ) sub
    WHERE e.id = sub.entity_id;
  `);

  runSQL("Primary contract type", `
    UPDATE entities e SET primary_contract_type = sub.contract_type
    FROM (
      SELECT DISTINCT ON (c.entity_id) c.entity_id, c.contract_type, COUNT(*) AS cnt
      FROM contracts c
      WHERE c.superseded IS NOT TRUE AND c.contract_type IS NOT NULL AND c.entity_id IS NOT NULL
      GROUP BY c.entity_id, c.contract_type
      ORDER BY c.entity_id, cnt DESC
    ) sub
    WHERE e.id = sub.entity_id;
  `);

  // Step 8: Refresh materialized views
  console.log(`\n${aggregateStatsStepLabel("materialized_views")}...`);
  // Only the read models that back published figures and are defined in
  // sql/matviews/ (installed by sql/install.sql).
  const matviews = [
    // Contracts per year and contract type.
    "contract_yearly_stats_mv",
    // Granting bodies: totals, competitive share and AIReF semaphore.
    "grant_organ_mv",
    "grant_organ_yearly_mv",
    "grant_organ_finalitat_mv",
    "grant_organ_beneficiaris_mv",
    // Per-year totals of entity_yearly_stats.
    "yearly_totals_mv",
  ];
  for (const mv of matviews) {
    // Try CONCURRENTLY first (requires unique index), fall back to blocking refresh
    const concurrentResult = runSQL(`Refresh ${mv}`, `REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv};`, { allowFailure: true });
    if (concurrentResult === "" || concurrentResult.includes("ERROR")) {
      runSQL(`Refresh ${mv} (blocking)`, `REFRESH MATERIALIZED VIEW ${mv};`);  // runSQL sets the timeout
    }
  }

  // Step 9: Refresh planner stats + visibility map on the large contracts table.
  // VACUUM (ANALYZE) is non-blocking; keep it last in the refresh. (VACUUM runs in psql
  // autocommit — never inside a transaction.)
  console.log(`\n${aggregateStatsStepLabel("vacuum_contracts")}...`);
  runSQL("VACUUM ANALYZE contracts", "VACUUM (ANALYZE) public.contracts;");

  assertFinalInvariants();

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Aggregation Complete in ${totalSec}s ===`);
}

main();
