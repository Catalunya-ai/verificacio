/**
 * Pure SQL score calculation v5.1 — runs entirely server-side via psql.
 *
 * Scoring components (equal weight, per IMF/Fazekas CRI standard):
 *   1. Volume         — percentile of total_public_funds                  [always]
 *   2. Frequency      — percentile of transactions per year               [≥100K floor]
 *   3. Dominance      — percentile within primary purpose / CPV           [≥100K floor]
 *   4. Concurrència   — market competition in contract awards             [≥25K classifiable]
 *   5. Accountability — REJC filing track record                          [optional]
 *
 * Composite = sum(non-null components) / count(non-null components).
 *
 * Concurrència classification (EC Single Market Scoreboard + LCSP art. 118):
 *   COMPETITIVE:     open procedure with ≥2 bidders
 *   NON_COMPETITIVE: contracte menor above LCSP legal threshold, negociat sense
 *                    publicitat, adjudicació directa, open with sole bidder
 *   UNKNOWN:         procedure_type NULL, open with no bidder data
 *   MENOR_LEGAL:     contracte menor under LCSP threshold (Obres <40K,
 *                    Serveis/Subministraments <15K) — legally exempt, excluded
 *
 * total_public_funds includes accio_concertada, so it feeds score_volume.
 * The threshold is not expanded for accio_concertada-only profiles; revisit
 * once DOGC ingestion exposes per-year granularity.
 *
 * Usage: npx tsx src/pipeline/calculate-scores-sql.ts
 *   (connection: DATABASE_URL, see src/lib/db.ts)
 */

import { createPsqlRunner, type RunSQLOpts } from "../lib/psql-runner";

const { runSQL: runPsqlSQL } = createPsqlRunner();

// Same pattern as aggregate-stats: the final entity-wide UPDATE can run for
// more than ten minutes on the full dataset. No scoring step should die on the
// default; the runner's process ceiling is 7200s, so keep this below it.
const STATEMENT_TIMEOUT = process.env.SCORES_STATEMENT_TIMEOUT || "3600s";

function runSQL(label: string, sql: string, opts: RunSQLOpts = {}): string {
  const start = Date.now();
  const timeoutPrefix = `SET statement_timeout = '${STATEMENT_TIMEOUT}';\n`;
  try {
    const output = runPsqlSQL(timeoutPrefix + sql, opts);
    const ms = Date.now() - start;
    console.log(`  ${label} (${ms}ms)${output ? " → " + output.substring(0, 200) : ""}`);
    return output;
  } catch (e: unknown) {
    const ms = Date.now() - start;
    const message = e instanceof Error ? e.message : String(e);
    const isTimeout = /statement timeout|canceling statement/i.test(message);
    console.error(`  ERROR: ${label} failed (${ms}ms): ${message.substring(0, 600)}`);
    if (isTimeout) {
      console.error(`  The limit was ${STATEMENT_TIMEOUT}. Raise it with SCORES_STATEMENT_TIMEOUT=5400s (the runner's process ceiling is 7200s and statement_timeout must stay below it).`);
    }
    throw e;
  }
}

function main() {
  console.log("=== Pure SQL Score Calculation v5.1 (equal weights + low-N floors) ===");
  console.log("Target: DATABASE_URL\n");
  const t0 = Date.now();

  // Step 1: Volume — percentile rank of total_public_funds
  console.log("Step 1: Volume scores (percentile of total_public_funds, equal weight)...");
  runSQL("Volume", `
    WITH eligible AS (
      SELECT id, COALESCE(total_public_funds, total_amount) AS funds
      FROM entities
      WHERE is_anonymized = false
        AND (total_grants + COALESCE(total_contracts, 0)) >= 1
        AND COALESCE(total_public_funds, total_amount) >= 25000
    )
    UPDATE entities e SET score_volume = ROUND((sub.pct * 100)::numeric, 2)
    FROM (
      SELECT id, PERCENT_RANK() OVER (ORDER BY funds ASC) AS pct
      FROM eligible
    ) sub
    WHERE e.id = sub.id;
  `);

  // Step 2: Frequency — percentile rank of (grants + contracts) per year
  // v5.1: Reset first (in case entity falls below floor in re-runs), then apply only to
  // entities with total_public_funds >= 100K (low-volume floor — prevents micro-entities
  // with many quota/membership payments from scoring high on frequency).
  console.log("\nStep 2: Frequency scores (percentile of txns/year, equal weight, ≥100K floor)...");
  runSQL("Frequency reset", `
    UPDATE entities SET score_frequency = NULL WHERE score_frequency IS NOT NULL;
  `);
  runSQL("Frequency", `
    WITH txns_per_year AS (
      SELECT id,
        (total_grants + COALESCE(total_contracts, 0))::numeric / GREATEST(
          GREATEST(
            COALESCE(last_grant_year, 0), COALESCE(last_contract_year, 0)
          ) - LEAST(
            COALESCE(NULLIF(first_grant_year, 0), 9999),
            COALESCE(NULLIF(first_contract_year, 0), 9999)
          ) + 1,
          1
        ) AS tpy
      FROM entities
      WHERE is_anonymized = false
        AND COALESCE(total_public_funds, total_amount) >= 100000
        AND (COALESCE(first_grant_year, 0) > 0 OR COALESCE(first_contract_year, 0) > 0)
        AND (COALESCE(last_grant_year, 0) > 0 OR COALESCE(last_contract_year, 0) > 0)
    )
    UPDATE entities e SET score_frequency = ROUND((sub.pct * 100)::numeric, 2)
    FROM (
      SELECT id, PERCENT_RANK() OVER (ORDER BY tpy ASC) AS pct
      FROM txns_per_year
      WHERE tpy > 0
    ) sub
    WHERE e.id = sub.id;
  `);

  // Step 3: Weighted Dominance — grants (finalitat_rais) + contracts (CPV-3)
  // Reset dominance first. Apply a 100K absolute floor on the entity's primary purpose
  // amount. Below the floor → NULL.
  console.log("\nStep 3: Weighted dominance (grants finalitat_rais + contracts CPV-3, ≥100K floor)...");

  runSQL("Dominance reset", `
    UPDATE entities SET score_dominance = NULL WHERE score_dominance IS NOT NULL;
  `);

  // 3a: Grant dominance — requires entity_purpose_amount >= 100K
  // Catalan scope: RAISC rows (by source_dataset) plus any row with ccaa_code = 'CAT';
  // superseded rows are excluded.
  runSQL("Grant dominance", `
    WITH purpose_entity AS (
      SELECT entity_id,
        COALESCE(finalitat_rais, purpose) AS purpose_key,
        SUM(amount) AS entity_purpose_amount
      FROM grants
      WHERE superseded IS NOT TRUE
        AND is_credit IS NOT TRUE
        AND entity_id IS NOT NULL
        AND (source_dataset = 'raisc_concessions' OR ccaa_code = 'CAT')
        AND COALESCE(finalitat_rais, purpose) IS NOT NULL
      GROUP BY entity_id, COALESCE(finalitat_rais, purpose)
    ),
    primary_purpose AS (
      SELECT DISTINCT ON (entity_id) entity_id, purpose_key, entity_purpose_amount
      FROM purpose_entity
      ORDER BY entity_id, entity_purpose_amount DESC
    ),
    primary_purpose_qualified AS (
      SELECT * FROM primary_purpose WHERE entity_purpose_amount >= 100000
    ),
    qualifying_purposes AS (
      SELECT purpose_key FROM primary_purpose_qualified GROUP BY purpose_key HAVING COUNT(*) >= 10
    ),
    grant_dom AS (
      SELECT pp.entity_id,
        PERCENT_RANK() OVER (PARTITION BY pp.purpose_key ORDER BY pp.entity_purpose_amount) * 100 AS dom_grants
      FROM primary_purpose_qualified pp
      JOIN qualifying_purposes qp ON qp.purpose_key = pp.purpose_key
    )
    UPDATE entities e SET score_dominance = ROUND(gd.dom_grants::numeric, 2)
    FROM grant_dom gd WHERE e.id = gd.entity_id;
  `);

  // 3b: Contract dominance (CPV-3) + weighted combination
  // v5.1: Contract dominance requires entity's CPV3 amount >= 100K (floor).
  // Weighted combination: dominance = NULL when BOTH grant_dom and contract_dom are NULL
  // (i.e., entity has no purpose group above 100K). Otherwise weighted by amount share.
  runSQL("Contract CPV dominance + weighted combo", `
    WITH contract_cpv AS (
      SELECT entity_id,
        LEFT(SPLIT_PART(cpv_code, '||', 1), 3) AS cpv3,
        SUM(amount) AS cpv_amount
      FROM contracts
      WHERE cpv_code IS NOT NULL AND cpv_code != ''
        AND superseded IS NOT TRUE AND entity_id IS NOT NULL
      GROUP BY entity_id, LEFT(SPLIT_PART(cpv_code, '||', 1), 3)
    ),
    entity_primary_cpv AS (
      SELECT DISTINCT ON (entity_id) entity_id, cpv3, cpv_amount
      FROM contract_cpv
      ORDER BY entity_id, cpv_amount DESC
    ),
    entity_primary_cpv_qualified AS (
      SELECT * FROM entity_primary_cpv WHERE cpv_amount >= 100000
    ),
    cpv_group_counts AS (
      SELECT cpv3, COUNT(*) AS n FROM entity_primary_cpv_qualified GROUP BY cpv3
    ),
    contract_dom AS (
      SELECT epc.entity_id,
        PERCENT_RANK() OVER (PARTITION BY epc.cpv3 ORDER BY epc.cpv_amount) * 100 AS dom_cpv
      FROM entity_primary_cpv_qualified epc
      JOIN cpv_group_counts cgc ON cgc.cpv3 = epc.cpv3 AND cgc.n >= 10
    ),
    weighted AS (
      SELECT e.id,
        CASE
          -- Both components NULL → no qualifying primary purpose ≥100K → dominance NULL
          WHEN e.score_dominance IS NULL AND cd.dom_cpv IS NULL THEN NULL
          WHEN COALESCE(e.total_public_funds, 0) = 0 THEN COALESCE(e.score_dominance, cd.dom_cpv)
          ELSE ROUND((
            (COALESCE(e.total_amount, 0) / e.total_public_funds) * COALESCE(e.score_dominance, 0) +
            (COALESCE(e.total_contract_amount, 0) / e.total_public_funds) * COALESCE(cd.dom_cpv, 0)
          )::numeric, 2)
        END AS weighted_dom
      FROM entities e
      LEFT JOIN contract_dom cd ON cd.entity_id = e.id
      WHERE e.total_public_funds >= 25000
    )
    UPDATE entities e SET score_dominance = w.weighted_dom
    FROM weighted w WHERE e.id = w.id;
  `);

  // Step 4: Concurrència — market competition in contract awards
  // Aligned with EC Single Market Scoreboard and OCDS Red Flags standards
  console.log("\nStep 4: Concurrència (market competition, equal weight, conditional on >= 25K contracts)...");

  // v5.1: Reset before recompute so the new classifiable floor applies cleanly
  runSQL("Concurrència reset", `
    UPDATE entities SET idx_market_competition = NULL, score_concurrencia = NULL
    WHERE idx_market_competition IS NOT NULL OR score_concurrencia IS NOT NULL;
  `);

  // 4a: Classify contracts and compute Market Competition Index per entity
  runSQL("Market Competition Index", `
    WITH contract_classified AS (
      SELECT
        c.entity_id,
        c.amount,
        CASE
          -- v5.1: Contracte menor under LCSP art. 118 legal threshold → MENOR_LEGAL.
          -- LCSP allows minor contracts without tender below: Obres <40K, Serveis/Subministraments <15K.
          -- These contracts are legally exempt from competitive tender. They are NEITHER competitive
          -- nor non-competitive in any meaningful sense — they were never required to compete.
          -- Excluded from numerator AND denominator (do not affect the concurrence score).
          WHEN c.procedure_type = 'Contracte menor' AND c.contract_type = 'Obres' AND c.amount < 40000 THEN 'MENOR_LEGAL'
          WHEN c.procedure_type = 'Contracte menor' AND c.contract_type IN ('Serveis', 'Subministraments') AND c.amount < 15000 THEN 'MENOR_LEGAL'
          -- Above legal threshold (or rare contract_type values): still NON_COMPETITIVE
          WHEN c.procedure_type = 'Contracte menor' THEN 'NON_COMPETITIVE'
          -- NON-COMPETITIVE: direct awards, negotiated without publicity
          WHEN c.procedure_type IN (
            'Negociat sense publicitat',
            'Adjudicacions directes no menors',
            'Licitació amb negociació'
          ) THEN 'NON_COMPETITIVE'
          WHEN c.procedure_type IN (
            'Obert', 'Obert simplificat', 'Obert simplificat abreujat', 'Obert Simplificat',
            'Concurs de projectes', 'Restringit', 'Diàleg competitiu',
            'Específic de Sistema Dinàmic d''adquisició'
          ) AND c.num_bidders = 1 THEN 'NON_COMPETITIVE'
          -- COMPETITIVE: open procedure with real competition
          WHEN c.procedure_type IN (
            'Obert', 'Obert simplificat', 'Obert simplificat abreujat', 'Obert Simplificat',
            'Concurs de projectes', 'Restringit', 'Diàleg competitiu',
            'Específic de Sistema Dinàmic d''adquisició'
          ) AND c.num_bidders >= 2 THEN 'COMPETITIVE'
          -- UNKNOWN: open with no bidder data, semi-competitive, or NULL procedure
          ELSE 'UNKNOWN'
        END AS competition_level
      FROM contracts c
      WHERE c.superseded IS NOT TRUE
        AND c.entity_id IS NOT NULL
        AND c.amount > 0
    ),
    entity_competition AS (
      SELECT
        entity_id,
        -- Amount-weighted non-competitive ratio. UNKNOWN and MENOR_LEGAL are
        -- excluded from numerator AND denominator.
        COALESCE(
          SUM(amount) FILTER (WHERE competition_level = 'NON_COMPETITIVE')
          / NULLIF(SUM(amount) FILTER (WHERE competition_level NOT IN ('UNKNOWN', 'MENOR_LEGAL')), 0),
          0
        ) AS pct_non_competitive,
        SUM(amount) FILTER (WHERE competition_level NOT IN ('UNKNOWN', 'MENOR_LEGAL')) AS classifiable_amount
      FROM contract_classified
      GROUP BY entity_id
    ),
    eligible_concurrencia AS (
      SELECT
        ec.entity_id,
        -- HIGH value = HIGH non-competitive ratio = BAD (score alto = malo)
        ec.pct_non_competitive * 100 AS idx_market_raw
      FROM entity_competition ec
      JOIN entities e ON e.id = ec.entity_id
      -- v5.1: also require classifiable_amount >= 25K so we don't score entities whose only
      -- "classifiable" volume is a couple of contracts above the LCSP menor threshold.
      WHERE e.total_contract_amount >= 25000
        AND ec.classifiable_amount >= 25000
        AND e.is_anonymized = false
    )
    -- M2: Absolute values instead of PERCENT_RANK (per EC Scoreboard methodology)
    -- score = pct_non_competitive directly. 89% non-competitive = score 89. Interpretable.
    UPDATE entities e
    SET idx_market_competition = ROUND(sub.idx_market_raw::numeric, 2)
    FROM (SELECT entity_id, idx_market_raw FROM eligible_concurrencia) sub
    WHERE e.id = sub.entity_id;
  `);

  // 4b: Compute score_concurrencia (with conditional fragmentation)
  // Fragmentation activates only when fragmentation_count >= 5 AND fragmentation_risk >= 5%
  runSQL("Concurrència composite", `
    -- M2: Fragmentation also absolute. frag_pct = % of contracts in near-threshold range.
    -- Capped at 100. Most entities have 0 (no fragmentation) → score contribution = 0.
    WITH frag_eligible AS (
      SELECT id,
        LEAST(100, (fragmentation_count::float / NULLIF(total_contracts, 0)) * 500) AS frag_score
      FROM entities
      WHERE total_contract_amount >= 25000
        AND fragmentation_count >= 5
        AND fragmentation_risk >= 5
        AND is_anonymized = false
    )
    UPDATE entities e SET score_concurrencia = ROUND(
      CASE
        -- Entities WITH fragmentation data: 70% market + 30% fragmentation
        WHEN fe.frag_score IS NOT NULL THEN
          0.70 * COALESCE(e.idx_market_competition, 0) + 0.30 * fe.frag_score
        -- Entities WITHOUT fragmentation: 100% market competition
        ELSE e.idx_market_competition
      END::numeric, 2
    )
    FROM (SELECT id FROM entities WHERE total_contract_amount >= 25000 AND idx_market_competition IS NOT NULL AND is_anonymized = false) eligible
    LEFT JOIN frag_eligible fe ON fe.id = eligible.id
    WHERE e.id = eligible.id;
  `);

  runSQL("Concurrència stats", `
    SELECT
      COUNT(*) FILTER (WHERE score_concurrencia IS NOT NULL) AS with_concurrencia,
      COUNT(*) FILTER (WHERE score_concurrencia IS NULL AND menjometre_score > 0) AS scored_without,
      ROUND(AVG(score_concurrencia)::numeric, 1) AS avg_score,
      ROUND(MIN(score_concurrencia)::numeric, 1) AS min_score,
      ROUND(MAX(score_concurrencia)::numeric, 1) AS max_score
    FROM entities;
  `);

  // Step 5: Final menjometre_score with equal weights over the non-null components
  // Single UPDATE handles all combinations of optional components
  console.log("\nStep 5: Computing final menjometre_score (v5 equal weights)...");

  // Reset scores for entities below threshold
  runSQL("Zero below-threshold", `
    UPDATE entities SET menjometre_score = 0, score_concurrencia = NULL
    WHERE (total_grants + COALESCE(total_contracts, 0)) < 1
      OR COALESCE(total_public_funds, total_amount) < 25000
      OR is_anonymized = true;
  `);

  // v5.1: ALL components are now optional (frequency + dominance gain ≥100K floor,
  // concurrència gains classifiable-amount floor). Volume is always present for scored
  // entities (≥25K threshold guarantees it). N = number of NON-NULL components.
  // Floor: at least volume must be present, so N ≥ 1.
  runSQL("Equal-weight score (v5.1)", `
    UPDATE entities SET menjometre_score = ROUND(
      (
        COALESCE(score_volume, 0)
      + COALESCE(score_frequency, 0)
      + COALESCE(score_dominance, 0)
      + COALESCE(score_concurrencia, 0)
      + COALESCE(score_accountability, 0)
      ) / NULLIF(
        (CASE WHEN score_volume IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN score_frequency IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN score_dominance IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN score_concurrencia IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN score_accountability IS NOT NULL THEN 1 ELSE 0 END)
      , 0)
    ::numeric, 2)
    WHERE (total_grants + COALESCE(total_contracts, 0)) >= 1
      AND COALESCE(total_public_funds, total_amount) >= 25000
      AND is_anonymized = false;
  `);

  // Summary stats
  console.log("\nStep 6: Summary...");
  runSQL("Scored entities", `
    SELECT COUNT(*) AS scored FROM entities WHERE menjometre_score > 0;
  `);
  runSQL("Top 10 scores", `
    SELECT slug || '|' || menjometre_score || '|' || score_volume || '|' || score_frequency || '|' || score_dominance
    FROM entities WHERE menjometre_score > 0
    ORDER BY menjometre_score DESC LIMIT 10;
  `);
  runSQL("Contract-only scored", `
    SELECT COUNT(*) FROM entities WHERE menjometre_score > 0 AND total_grants = 0;
  `);


  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Scoring v5 (equal weights) Complete in ${totalSec}s ===`);
}

main();
