/**
 * Entity Consolidation Script
 *
 * Merges orphan entities (no CIF) into canonical entities (with CIF)
 * when the orphan's grants/contracts carry a CIF matching a canonical entity.
 *
 * Usage:
 *   npx tsx src/pipeline/consolidate-entities.ts --dry-run   # Preview changes
 *   npx tsx src/pipeline/consolidate-entities.ts              # Apply changes
 *   (connection: DATABASE_URL, see src/lib/db.ts)
 *
 * Must run AFTER sync pipelines and BEFORE aggregation/scoring.
 */

import { createPsqlRunner } from "../lib/psql-runner";

const DRY_RUN = process.argv.includes("--dry-run");
const psql = createPsqlRunner();

// CIFs that are placeholders/fake — must NEVER be used for merging
const BLOCKED_CIFS = [
  "A00000000", "B00000000", "00000000", "A00000001", "B00000001",
  "ESTRANGER", "DESCONEGUT", "VARIOS", "DIVERSE",
];
const BLOCKED_CIF_SQL = BLOCKED_CIFS.map((c) => `'${c}'`).join(",");

function runSQL(sql: string): string {
  try {
    return psql.runSQL(sql).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`SQL error: ${msg}`);
    throw err;
  }
}

function runSQLTransaction(statements: string[]): string {
  // One transaction; ON_ERROR_STOP=1 makes psql stop at the first error, the
  // runner throws, and the transaction is rolled back.
  const sql = ["BEGIN;", ...statements, "COMMIT;"].join("\n");
  return psql.runSQLFile(sql).trim();
}

// ============================================================
// Pre-flight checks
// ============================================================

function preflight() {
  console.log("=== Pre-flight checks ===\n");

  // Snapshot
  const snapshot = runSQL(`
    SELECT
      (SELECT COUNT(*) FROM entities) AS total_entities,
      (SELECT COUNT(*) FROM entities WHERE cif IS NOT NULL) AS entities_with_cif,
      (SELECT COUNT(*) FROM grants WHERE superseded IS NOT TRUE) AS total_grants,
      (SELECT SUM(amount) FROM grants WHERE superseded IS NOT TRUE) AS total_grant_amount,
      (SELECT COUNT(*) FROM contracts) AS total_contracts,
      (SELECT SUM(amount) FROM contracts) AS total_contract_amount;
  `);
  console.log("Current snapshot:");
  console.log(snapshot);
  console.log();

  // Multi-CIF orphans
  const multiCif = runSQL(`
    SELECT COUNT(*) FROM (
      SELECT e.id, COUNT(DISTINCT g.cif) AS cif_count
      FROM entities e
      JOIN grants g ON g.entity_id = e.id
      WHERE e.cif IS NULL AND g.cif IS NOT NULL AND g.cif != '' AND g.cif NOT IN (${BLOCKED_CIF_SQL}) AND g.source_dataset = 'raisc_concessions' AND g.superseded IS NOT TRUE
      GROUP BY e.id HAVING COUNT(DISTINCT g.cif) > 1
    ) sub;
  `);
  console.log(`Multi-CIF orphans (need splitting): ${multiCif}`);

  // Category B: orphans whose grant CIF is unclaimed
  const catB = runSQL(`
    SELECT COUNT(DISTINCT g.cif) FROM grants g
    JOIN entities e ON g.entity_id = e.id
    WHERE e.cif IS NULL AND g.cif IS NOT NULL AND g.cif != '' AND g.cif NOT IN (${BLOCKED_CIF_SQL}) AND g.source_dataset = 'raisc_concessions' AND g.superseded IS NOT TRUE
    AND NOT EXISTS (SELECT 1 FROM entities e2 WHERE e2.cif = g.cif);
  `);
  console.log(`Category B (unclaimed CIFs to assign): ${catB}`);

  // Category A: orphans whose grant CIF matches an existing entity
  const catA = runSQL(`
    SELECT COUNT(DISTINCT e.id) FROM entities e
    JOIN grants g ON g.entity_id = e.id AND g.cif IS NOT NULL AND g.superseded IS NOT TRUE
    JOIN entities e2 ON e2.cif = g.cif AND e2.id != e.id
    WHERE e.cif IS NULL;
  `);
  console.log(`Category A (mergeable orphans): ${catA}`);

  // Category C: contract-only orphans (lightweight count, person filter applied at merge time)
  const catC = runSQL(`
    SELECT COUNT(DISTINCT e.id) FROM entities e
    JOIN contracts c ON c.entity_id = e.id
      AND c.cif IS NOT NULL AND c.cif != ''
      AND c.cif NOT IN (${BLOCKED_CIF_SQL})
    WHERE e.cif IS NULL
      AND EXISTS (SELECT 1 FROM entities e2 WHERE e2.cif = c.cif AND e2.id != e.id);
  `);
  console.log(`Category C (contract-only orphans, ~${catC} before person filter)`);

  console.log();
}

// ============================================================
// Build the consolidation SQL
// ============================================================

function buildConsolidationSQL(): string[] {
  const stmts: string[] = [];

  // Transaction-scoped advisory lock (auto-releases on COMMIT/ROLLBACK)
  stmts.push("SELECT pg_advisory_xact_lock(42);");

  // Create merge log table if not exists (append-only for audit trail)
  stmts.push(`
    CREATE TABLE IF NOT EXISTS entity_merge_log (
      id SERIAL PRIMARY KEY,
      old_entity_id UUID NOT NULL,
      old_slug TEXT NOT NULL,
      canonical_id UUID NOT NULL,
      canonical_slug TEXT NOT NULL,
      cif TEXT,
      merge_type TEXT,
      merged_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ---- Step 1.1: Category B — Assign CIF to orphan entities ----
  stmts.push(`
    -- Step 1.1: Assign unclaimed CIFs to orphan entities
    WITH grant_cifs AS (
      SELECT DISTINCT g.cif
      FROM grants g
      WHERE g.cif IS NOT NULL AND g.cif != '' AND g.cif NOT IN (${BLOCKED_CIF_SQL}) AND g.source_dataset = 'raisc_concessions'
        AND g.superseded IS NOT TRUE
        AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.cif = g.cif)
    ),
    orphan_candidates AS (
      SELECT e.id, e.slug, g.cif,
        COUNT(*) AS grant_count, SUM(g.amount) AS total_amount
      FROM grants g
      JOIN entities e ON g.entity_id = e.id
      WHERE e.cif IS NULL
        AND g.cif IN (SELECT cif FROM grant_cifs)
        AND g.superseded IS NOT TRUE
      GROUP BY e.id, e.slug, g.cif
    ),
    best_per_cif AS (
      SELECT DISTINCT ON (cif)
        id AS canonical_id, slug AS canonical_slug, cif
      FROM orphan_candidates
      ORDER BY cif, grant_count DESC, total_amount DESC, id ASC
    )
    UPDATE entities e SET cif = bpc.cif, updated_at = NOW()
    FROM best_per_cif bpc WHERE e.id = bpc.canonical_id;
  `);

  // Log CIF assignments
  stmts.push(`
    -- (CIF assignments are logged implicitly; the entities now have CIF
    --  and may appear as canonical targets in Step 1.2)
  `);

  // ---- Step 1.2: Category A — Merge orphans into canonical entities ----

  // 1.2a: Build merge map
  stmts.push(`
    -- Step 1.2a: Build merge map
    CREATE TEMP TABLE orphan_merge AS
    SELECT DISTINCT e_orphan.id AS old_id, e_orphan.slug AS old_slug,
      e_canon.id AS canonical_id, e_canon.slug AS canonical_slug, e_canon.cif
    FROM entities e_orphan
    JOIN grants g ON g.entity_id = e_orphan.id
      AND g.cif IS NOT NULL AND g.cif != '' AND g.cif NOT IN (${BLOCKED_CIF_SQL}) AND g.source_dataset = 'raisc_concessions' AND g.superseded IS NOT TRUE
    JOIN entities e_canon ON e_canon.cif = g.cif
    WHERE e_orphan.cif IS NULL AND e_orphan.id != e_canon.id
    -- Never merge PFA (person) with organization
    AND NOT (e_orphan.beneficiary_type = 'PFA' AND e_canon.beneficiary_type IS DISTINCT FROM 'PFA')
    AND NOT (e_orphan.beneficiary_type IS DISTINCT FROM 'PFA' AND e_canon.beneficiary_type = 'PFA');
  `);

  // Log merges
  stmts.push(`
    INSERT INTO entity_merge_log (old_entity_id, old_slug, canonical_id, canonical_slug, cif, merge_type)
    SELECT old_id, old_slug, canonical_id, canonical_slug, cif, 'grant_cif'
    FROM orphan_merge;
  `);

  // 1.2b: Handle dedup index conflicts on grants
  // Optimized: only check orphan BDNS grants (small set) against a temp table of canonical BDNS grants
  stmts.push(`
    -- Step 1.2b: Build canonical BDNS grant keys for conflict check
    CREATE TEMP TABLE canon_bdns_keys AS
    SELECT DISTINCT entity_slug, bdns_code, amount, department
    FROM grants
    WHERE raisc_clau IS NULL AND bdns_code IS NOT NULL
      AND entity_slug IN (SELECT DISTINCT canonical_slug FROM orphan_merge);

    -- Mark orphan grants that would conflict
    UPDATE grants SET raisc_clau = 'MERGE_DEDUP_' || id::text
    WHERE id IN (
      SELECT orphan_g.id FROM grants orphan_g
      JOIN orphan_merge om ON orphan_g.entity_id = om.old_id
      JOIN canon_bdns_keys cbk ON cbk.entity_slug = om.canonical_slug
        AND cbk.bdns_code = orphan_g.bdns_code
        AND cbk.amount = orphan_g.amount
        AND cbk.department = orphan_g.department
      WHERE orphan_g.raisc_clau IS NULL AND orphan_g.bdns_code IS NOT NULL
    );
  `);

  // 1.2c: Reassign grants
  stmts.push(`
    -- Step 1.2c: Reassign grants from orphans to canonical
    UPDATE grants g SET
      entity_id = e_canon.id,
      entity_slug = e_canon.slug
    FROM entities e_canon
    WHERE g.cif IS NOT NULL AND g.cif != '' AND g.cif NOT IN (${BLOCKED_CIF_SQL}) AND g.source_dataset = 'raisc_concessions'
      AND e_canon.cif = g.cif
      AND g.entity_id IN (SELECT old_id FROM orphan_merge)
      AND g.entity_id != e_canon.id;
  `);

  // Also reassign grants without CIF (rare, but possible on orphans)
  stmts.push(`
    UPDATE grants g SET
      entity_id = om.canonical_id,
      entity_slug = om.canonical_slug
    FROM orphan_merge om
    WHERE g.entity_id = om.old_id
      AND (g.cif IS NULL OR g.cif = '');
  `);

  // 1.2d: Reassign contracts (handle both CIF and non-CIF)
  stmts.push(`
    -- Step 1.2d: Reassign CIF contracts
    -- First mark CIF contract duplicates (same cif+expedient+lot on multiple orphans or canonical)
    WITH cif_contracts_to_move AS (
      SELECT c.id, c.cif, c.codi_expedient, COALESCE(c.lot_number, '') AS ln,
        ROW_NUMBER() OVER (
          PARTITION BY c.cif, c.codi_expedient, COALESCE(c.lot_number, '')
          ORDER BY c.id
        ) AS rn
      FROM contracts c
      WHERE c.cif IS NOT NULL AND c.cif != '' AND c.cif NOT IN (${BLOCKED_CIF_SQL})
        AND c.codi_expedient IS NOT NULL
        AND c.entity_id IN (SELECT old_id FROM orphan_merge)
    ),
    already_on_canonical_cif AS (
      SELECT c.cif, c.codi_expedient, COALESCE(c.lot_number, '') AS ln
      FROM contracts c
      JOIN entities e ON c.entity_id = e.id AND e.cif IS NOT NULL
      WHERE c.cif IS NOT NULL AND c.cif != '' AND c.cif NOT IN (${BLOCKED_CIF_SQL})
        AND c.codi_expedient IS NOT NULL
        AND c.entity_id NOT IN (SELECT old_id FROM orphan_merge)
        AND c.cif IN (SELECT cif FROM orphan_merge)
        AND c.superseded IS NOT TRUE
    ),
    to_supersede_cif AS (
      SELECT id FROM cif_contracts_to_move WHERE rn > 1
      UNION
      SELECT ctm.id FROM cif_contracts_to_move ctm
      JOIN already_on_canonical_cif aoc ON ctm.cif = aoc.cif
        AND ctm.codi_expedient = aoc.codi_expedient AND ctm.ln = aoc.ln
    )
    UPDATE contracts SET superseded = TRUE WHERE id IN (SELECT id FROM to_supersede_cif);

    -- Now reassign non-superseded CIF contracts
    UPDATE contracts c SET
      entity_id = e_canon.id,
      entity_slug = e_canon.slug
    FROM entities e_canon
    WHERE c.cif IS NOT NULL AND c.cif != '' AND c.cif NOT IN (${BLOCKED_CIF_SQL})
      AND e_canon.cif = c.cif
      AND c.entity_id IN (SELECT old_id FROM orphan_merge)
      AND c.entity_id != e_canon.id
      AND c.superseded IS NOT TRUE;
  `);

  // Non-CIF contracts via merge map — handle ALL dedup conflicts
  stmts.push(`
    -- Find ALL non-CIF contract conflicts: between orphans AND with canonical
    -- Keep only the first (by id) per (canonical_slug, codi_expedient, lot_number)
    WITH contracts_to_move AS (
      SELECT c.id, om.canonical_slug,
        c.codi_expedient, COALESCE(c.lot_number, '') AS ln,
        ROW_NUMBER() OVER (
          PARTITION BY om.canonical_slug, c.codi_expedient, COALESCE(c.lot_number, '')
          ORDER BY c.id
        ) AS rn
      FROM contracts c
      JOIN orphan_merge om ON c.entity_id = om.old_id
      WHERE (c.cif IS NULL OR c.cif = '')
        AND c.codi_expedient IS NOT NULL
    ),
    -- Also check conflicts with contracts already on canonical entity
    already_on_canonical AS (
      SELECT c.codi_expedient, c.entity_slug, COALESCE(c.lot_number, '') AS ln
      FROM contracts c
      WHERE (c.cif IS NULL OR c.cif = '')
        AND c.codi_expedient IS NOT NULL
        AND c.entity_slug IN (SELECT DISTINCT canonical_slug FROM orphan_merge)
        AND c.superseded IS NOT TRUE
    ),
    to_supersede AS (
      -- Duplicates between orphans (keep first, supersede rest)
      SELECT id FROM contracts_to_move WHERE rn > 1
      UNION
      -- Duplicates with canonical (supersede orphan copy)
      SELECT ctm.id FROM contracts_to_move ctm
      JOIN already_on_canonical aoc ON ctm.canonical_slug = aoc.entity_slug
        AND ctm.codi_expedient = aoc.codi_expedient
        AND ctm.ln = aoc.ln
    )
    UPDATE contracts SET superseded = TRUE WHERE id IN (SELECT id FROM to_supersede);

    -- Now reassign the non-conflicting ones
    UPDATE contracts c SET
      entity_id = om.canonical_id,
      entity_slug = om.canonical_slug
    FROM orphan_merge om
    WHERE c.entity_id = om.old_id
      AND (c.cif IS NULL OR c.cif = '')
      AND c.superseded IS NOT TRUE;
  `);

  // 1.2e: Reassign ALL FK tables BEFORE entity deletion
  stmts.push(`
    -- Step 1.2e: Reassign FK tables

    -- entity_financials_yearly (CASCADE — would be deleted)
    UPDATE entity_financials_yearly SET entity_id = om.canonical_id
    FROM orphan_merge om WHERE entity_financials_yearly.entity_id = om.old_id;

    -- contracts already reassigned in step 1.2d (both CIF and non-CIF)
    -- Remaining contracts on orphans are superseded — detach entity_id to avoid FK failure
    UPDATE contracts SET entity_id = om.canonical_id
    FROM orphan_merge om WHERE contracts.entity_id = om.old_id;

    -- convenis (NO ACTION — would fail)
    UPDATE convenis SET entity_id = om.canonical_id
    FROM orphan_merge om WHERE convenis.entity_id = om.old_id;

    -- accio_concertada (RESTRICT — would fail)
    UPDATE accio_concertada SET entity_id = om.canonical_id, entity_slug = om.canonical_slug
    FROM orphan_merge om WHERE accio_concertada.entity_id = om.old_id;

    -- entity_connections (delete orphan connections, will be recalculated by network analysis)
    DELETE FROM entity_connections WHERE entity_id IN (SELECT old_id FROM orphan_merge);
    DELETE FROM entity_connections WHERE related_entity_id IN (SELECT old_id FROM orphan_merge);

    -- entity_yearly_stats (CASCADE — delete, will recalculate)
    DELETE FROM entity_yearly_stats WHERE entity_id IN (SELECT old_id FROM orphan_merge);
  `);

  // 1.2f: Merge enrichment data
  stmts.push(`
    -- Step 1.2f: Merge enrichment data (COALESCE — canonical wins, orphan fills gaps)
    UPDATE entities canon SET
      municipality = COALESCE(canon.municipality, donor.municipality),
      comarca = COALESCE(canon.comarca, donor.comarca),
      comarca_code = COALESCE(canon.comarca_code, donor.comarca_code),
      province_code = COALESCE(canon.province_code, donor.province_code),
      beneficiary_type = COALESCE(canon.beneficiary_type, donor.beneficiary_type),
      in_official_registry = COALESCE(canon.in_official_registry, donor.in_official_registry),
      updated_at = NOW()
    FROM (
      SELECT DISTINCT ON (om.canonical_id)
        om.canonical_id,
        e.municipality, e.comarca, e.comarca_code, e.province_code,
        e.beneficiary_type, e.in_official_registry
      FROM orphan_merge om
      JOIN entities e ON e.id = om.old_id
      WHERE e.municipality IS NOT NULL OR e.comarca IS NOT NULL
        OR e.beneficiary_type IS NOT NULL
      ORDER BY om.canonical_id, e.total_grants DESC NULLS LAST
    ) donor
    WHERE canon.id = donor.canonical_id;
  `);

  // 1.2g: Slug redirects and delete orphans
  stmts.push(`
    -- Step 1.2g: Create slug redirects
    INSERT INTO slug_redirects (old_slug, cif)
    SELECT DISTINCT old_slug, cif FROM orphan_merge
    ON CONFLICT (old_slug) DO NOTHING;
  `);

  // Safety: reassign ANY remaining grants/contracts before delete
  stmts.push(`
    -- Catch-all: recreate entities for any grants still pointing to orphans
    -- (multi-CIF orphans whose grants weren't reassigned by the CIF-based logic)
    INSERT INTO entities (slug, name)
    SELECT DISTINCT g.entity_slug, g.entity_slug
    FROM grants g
    WHERE g.entity_id IN (SELECT old_id FROM orphan_merge)
      AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.slug = g.entity_slug AND e.id != g.entity_id)
    ON CONFLICT (slug) DO NOTHING;

    -- Point orphaned grants to the recreated entity
    UPDATE grants g SET entity_id = e.id
    FROM entities e
    WHERE e.slug = g.entity_slug
      AND g.entity_id IN (SELECT old_id FROM orphan_merge)
      AND e.id NOT IN (SELECT old_id FROM orphan_merge);

    -- Same for contracts
    UPDATE contracts c SET entity_id = e.id
    FROM entities e
    WHERE e.slug = c.entity_slug
      AND c.entity_id IN (SELECT old_id FROM orphan_merge)
      AND e.id NOT IN (SELECT old_id FROM orphan_merge);
  `);

  stmts.push(`
    -- Now safe to delete: only entities with truly NO remaining FK references
    DELETE FROM entities WHERE id IN (
      SELECT old_id FROM orphan_merge
      WHERE NOT EXISTS (SELECT 1 FROM grants g WHERE g.entity_id = old_id)
        AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.entity_id = old_id)
        AND NOT EXISTS (SELECT 1 FROM convenis cv WHERE cv.entity_id = old_id)
    );
  `);

  // ---- Step 1.3: Category C — Contract-only orphans (with person filter) ----
  // Contract CIFs CAN be used for org-to-org merges, but NEVER for person-to-org merges
  // when the CIF is from a public entity (P/Q/S prefix) — these are GDPR placeholders.
  stmts.push(`
    -- Step 1.3: Contract-only orphans
    -- Assign CIF from contracts to entities that have none and no grant-based CIF
    WITH contract_cifs AS (
      SELECT DISTINCT c.cif
      FROM contracts c
      WHERE c.cif IS NOT NULL AND c.cif != '' AND c.cif NOT IN (${BLOCKED_CIF_SQL})
        AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.cif = c.cif)
    ),
    orphan_contract_candidates AS (
      SELECT e.id, e.slug, c.cif,
        COUNT(*) AS contract_count, SUM(c.amount) AS total_amount
      FROM contracts c
      JOIN entities e ON c.entity_id = e.id
      WHERE e.cif IS NULL
        AND c.cif IN (SELECT cif FROM contract_cifs)
      GROUP BY e.id, e.slug, c.cif
    ),
    best_per_cif AS (
      SELECT DISTINCT ON (cif)
        id, slug, cif
      FROM orphan_contract_candidates
      ORDER BY cif, contract_count DESC, total_amount DESC, id ASC
    )
    UPDATE entities e SET cif = bpc.cif, updated_at = NOW()
    FROM best_per_cif bpc WHERE e.id = bpc.id;
  `);

  // Merge contract-only orphans that now match a canonical entity
  stmts.push(`
    CREATE TEMP TABLE contract_orphan_merge AS
    SELECT DISTINCT e_orphan.id AS old_id, e_orphan.slug AS old_slug,
      e_canon.id AS canonical_id, e_canon.slug AS canonical_slug, e_canon.cif
    FROM entities e_orphan
    JOIN contracts c ON c.entity_id = e_orphan.id
      AND c.cif IS NOT NULL AND c.cif != '' AND c.cif NOT IN (${BLOCKED_CIF_SQL})
    JOIN entities e_canon ON e_canon.cif = c.cif
    WHERE e_orphan.cif IS NULL AND e_orphan.id != e_canon.id
    AND NOT EXISTS (SELECT 1 FROM orphan_merge WHERE old_id = e_orphan.id)
    -- Exclude person-to-org merges with public CIF (GDPR placeholder pattern)
    AND NOT (
      c.cif ~ '^[PQS]'
      AND e_orphan.slug ~ '^[A-Z]{3,}-[A-Z]{3,}-[A-Z]{3,}$'
      AND LENGTH(e_orphan.slug) < 35
      AND e_orphan.slug !~ '(S-L|S-A|SLU|SAU|SCCL|SCP|COOP|ASSOC|FUNDACI|AJUNTAMENT|CONSELL|CONSORCI|DIPUTACI|INSTITUT|HOSPITAL|UNIVERSIT)'
    );
  `);

  stmts.push(`
    INSERT INTO entity_merge_log (old_entity_id, old_slug, canonical_id, canonical_slug, cif, merge_type)
    SELECT old_id, old_slug, canonical_id, canonical_slug, cif, 'contract_cif'
    FROM contract_orphan_merge;
  `);

  // Reassign contracts for contract-only orphans (with dedup handling)
  stmts.push(`
    -- CIF contract dedup for Cat C
    WITH cif_contracts_c AS (
      SELECT c.id, c.cif, c.codi_expedient, COALESCE(c.lot_number, '') AS ln,
        ROW_NUMBER() OVER (PARTITION BY c.cif, c.codi_expedient, COALESCE(c.lot_number, '') ORDER BY c.id) AS rn
      FROM contracts c
      WHERE c.cif IS NOT NULL AND c.cif != '' AND c.cif NOT IN (${BLOCKED_CIF_SQL}) AND c.codi_expedient IS NOT NULL
        AND c.entity_id IN (SELECT old_id FROM contract_orphan_merge)
    ),
    already_canon_c AS (
      SELECT c.cif, c.codi_expedient, COALESCE(c.lot_number, '') AS ln
      FROM contracts c JOIN entities e ON c.entity_id = e.id AND e.cif IS NOT NULL
      WHERE c.cif IS NOT NULL AND c.cif != '' AND c.cif NOT IN (${BLOCKED_CIF_SQL}) AND c.codi_expedient IS NOT NULL
        AND c.entity_id NOT IN (SELECT old_id FROM contract_orphan_merge)
        AND c.cif IN (SELECT cif FROM contract_orphan_merge)
        AND c.superseded IS NOT TRUE
    ),
    to_sup_c AS (
      SELECT id FROM cif_contracts_c WHERE rn > 1
      UNION
      SELECT cc.id FROM cif_contracts_c cc JOIN already_canon_c ac
        ON cc.cif = ac.cif AND cc.codi_expedient = ac.codi_expedient AND cc.ln = ac.ln
    )
    UPDATE contracts SET superseded = TRUE WHERE id IN (SELECT id FROM to_sup_c);

    -- CIF contracts
    UPDATE contracts c SET entity_id = e_canon.id, entity_slug = e_canon.slug
    FROM entities e_canon
    WHERE c.cif IS NOT NULL AND c.cif != '' AND c.cif NOT IN (${BLOCKED_CIF_SQL}) AND e_canon.cif = c.cif
      AND c.entity_id IN (SELECT old_id FROM contract_orphan_merge)
      AND c.entity_id != e_canon.id AND c.superseded IS NOT TRUE;

    -- Non-CIF contract dedup for Cat C
    WITH noncif_c AS (
      SELECT c.id, com.canonical_slug,
        c.codi_expedient, COALESCE(c.lot_number, '') AS ln,
        ROW_NUMBER() OVER (PARTITION BY com.canonical_slug, c.codi_expedient, COALESCE(c.lot_number, '') ORDER BY c.id) AS rn
      FROM contracts c JOIN contract_orphan_merge com ON c.entity_id = com.old_id
      WHERE (c.cif IS NULL OR c.cif = '') AND c.codi_expedient IS NOT NULL
    ),
    already_canon_nc AS (
      SELECT entity_slug, codi_expedient, COALESCE(lot_number, '') AS ln
      FROM contracts WHERE (cif IS NULL OR cif = '') AND codi_expedient IS NOT NULL
        AND entity_slug IN (SELECT DISTINCT canonical_slug FROM contract_orphan_merge)
        AND superseded IS NOT TRUE
    ),
    to_sup_nc AS (
      SELECT id FROM noncif_c WHERE rn > 1
      UNION
      SELECT nc.id FROM noncif_c nc JOIN already_canon_nc ac
        ON nc.canonical_slug = ac.entity_slug AND nc.codi_expedient = ac.codi_expedient AND nc.ln = ac.ln
    )
    UPDATE contracts SET superseded = TRUE WHERE id IN (SELECT id FROM to_sup_nc);

    -- Non-CIF contracts
    UPDATE contracts c SET entity_id = com.canonical_id, entity_slug = com.canonical_slug
    FROM contract_orphan_merge com
    WHERE c.entity_id = com.old_id AND (c.cif IS NULL OR c.cif = '') AND c.superseded IS NOT TRUE;

    -- Remaining contracts (superseded, just update entity_id for FK)
    UPDATE contracts SET entity_id = com.canonical_id
    FROM contract_orphan_merge com WHERE contracts.entity_id = com.old_id;

    -- Reassign remaining FKs for contract-only orphans
    UPDATE convenis SET entity_id = com.canonical_id
    FROM contract_orphan_merge com WHERE convenis.entity_id = com.old_id;

    UPDATE accio_concertada SET entity_id = com.canonical_id, entity_slug = com.canonical_slug
    FROM contract_orphan_merge com WHERE accio_concertada.entity_id = com.old_id;

    DELETE FROM entity_connections WHERE entity_id IN (SELECT old_id FROM contract_orphan_merge);
    DELETE FROM entity_connections WHERE related_entity_id IN (SELECT old_id FROM contract_orphan_merge);

    UPDATE entity_financials_yearly SET entity_id = com.canonical_id
    FROM contract_orphan_merge com WHERE entity_financials_yearly.entity_id = com.old_id;

    DELETE FROM entity_yearly_stats WHERE entity_id IN (SELECT old_id FROM contract_orphan_merge);

    INSERT INTO slug_redirects (old_slug, cif)
    SELECT DISTINCT old_slug, cif FROM contract_orphan_merge
    ON CONFLICT (old_slug) DO NOTHING;

    -- Safe delete: only entities with no remaining FK references
    DELETE FROM entities WHERE id IN (
      SELECT old_id FROM contract_orphan_merge
      WHERE NOT EXISTS (SELECT 1 FROM grants g WHERE g.entity_id = old_id)
        AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.entity_id = old_id)
        AND NOT EXISTS (SELECT 1 FROM convenis cv WHERE cv.entity_id = old_id)
    );
  `);

  // Advisory xact lock auto-releases on COMMIT

  return stmts;
}

// ============================================================
// Dry run
// ============================================================

function dryRun() {
  console.log("=== DRY RUN — No changes will be applied ===\n");

  // Show what would be merged (top 20)
  const topMerges = runSQL(`
    SELECT LEFT(e_orphan.slug, 50) AS orphan, e_orphan.total_grants AS orphan_grants,
      e_orphan.total_amount AS orphan_amount,
      LEFT(e_canon.slug, 50) AS canonical, e_canon.total_grants AS canon_grants
    FROM entities e_orphan
    JOIN grants g ON g.entity_id = e_orphan.id
      AND g.cif IS NOT NULL AND g.cif != '' AND g.cif NOT IN (${BLOCKED_CIF_SQL}) AND g.source_dataset = 'raisc_concessions' AND g.superseded IS NOT TRUE
    JOIN entities e_canon ON e_canon.cif = g.cif
    WHERE e_orphan.cif IS NULL AND e_orphan.id != e_canon.id
    -- Never merge PFA (person) with organization
    AND NOT (e_orphan.beneficiary_type = 'PFA' AND e_canon.beneficiary_type IS DISTINCT FROM 'PFA')
    AND NOT (e_orphan.beneficiary_type IS DISTINCT FROM 'PFA' AND e_canon.beneficiary_type = 'PFA')
    GROUP BY e_orphan.id, e_orphan.slug, e_orphan.total_grants, e_orphan.total_amount,
      e_canon.id, e_canon.slug, e_canon.total_grants
    ORDER BY e_orphan.total_amount DESC
    LIMIT 20;
  `);
  console.log("Top 20 merges by amount:");
  console.log(topMerges);
  console.log();

  // Dedup index conflict preview
  const conflicts = runSQL(`
    SELECT COUNT(*) AS dedup_conflicts FROM (
      SELECT orphan_g.id FROM grants orphan_g
      JOIN (
        SELECT DISTINCT e_orphan.id AS old_id, e_canon.slug AS canonical_slug
        FROM entities e_orphan
        JOIN grants g ON g.entity_id = e_orphan.id
          AND g.cif IS NOT NULL AND g.superseded IS NOT TRUE
        JOIN entities e_canon ON e_canon.cif = g.cif
        WHERE e_orphan.cif IS NULL AND e_orphan.id != e_canon.id
    -- Never merge PFA (person) with organization
    AND NOT (e_orphan.beneficiary_type = 'PFA' AND e_canon.beneficiary_type IS DISTINCT FROM 'PFA')
    AND NOT (e_orphan.beneficiary_type IS DISTINCT FROM 'PFA' AND e_canon.beneficiary_type = 'PFA')
      ) om ON orphan_g.entity_id = om.old_id
      WHERE orphan_g.raisc_clau IS NULL AND orphan_g.bdns_code IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM grants canon_g
        WHERE canon_g.entity_slug = om.canonical_slug
        AND canon_g.bdns_code = orphan_g.bdns_code
        AND canon_g.amount = orphan_g.amount
        AND canon_g.department = orphan_g.department
        AND canon_g.raisc_clau IS NULL
      )
    ) sub;
  `);
  console.log(`Dedup index conflicts to handle: ${conflicts}`);
}

// ============================================================
// Post-flight verification
// ============================================================

function postFlight() {
  console.log("\n=== Post-flight verification ===\n");

  const snapshot = runSQL(`
    SELECT
      (SELECT COUNT(*) FROM entities) AS total_entities,
      (SELECT COUNT(*) FROM entities WHERE cif IS NOT NULL) AS entities_with_cif,
      (SELECT COUNT(*) FROM grants WHERE superseded IS NOT TRUE) AS total_grants,
      (SELECT SUM(amount) FROM grants WHERE superseded IS NOT TRUE) AS total_grant_amount,
      (SELECT COUNT(*) FROM contracts) AS total_contracts,
      (SELECT SUM(amount) FROM contracts) AS total_contract_amount;
  `);
  console.log("Post-merge snapshot:");
  console.log(snapshot);

  // Check remaining orphans
  const remaining = runSQL(`
    SELECT COUNT(DISTINCT e.id) FROM entities e
    JOIN grants g ON g.entity_id = e.id AND g.cif IS NOT NULL AND g.superseded IS NOT TRUE
    JOIN entities e2 ON e2.cif = g.cif AND e2.id != e.id
    WHERE e.cif IS NULL;
  `);
  console.log(`\nRemaining grant orphans: ${remaining}`);

  // Merge log summary
  try {
    const logSummary = runSQL(`
      SELECT merge_type, COUNT(*) AS merges FROM entity_merge_log
      GROUP BY merge_type ORDER BY merges DESC;
    `);
    console.log("\nMerge log summary:");
    console.log(logSummary);
  } catch {
    console.log("\nMerge log: table not found (transaction may have rolled back)");
  }

  // Slug redirects created
  const redirects = runSQL(`SELECT COUNT(*) AS slug_redirects FROM slug_redirects;`);
  console.log(`\nSlug redirects: ${redirects}`);
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log(`\nEntity Consolidation ${DRY_RUN ? "(DRY RUN)" : "(LIVE)"}\n`);

  preflight();

  if (DRY_RUN) {
    dryRun();
    console.log("\nDry run complete. No changes made.");
    console.log("Run without --dry-run to apply changes.");
    return;
  }

  console.log("=== Applying consolidation ===\n");

  const stmts = buildConsolidationSQL();
  const result = runSQLTransaction(stmts);
  console.log(result);

  postFlight();

  console.log("\n=== Post-consolidation tasks ===");
  console.log("Run these commands next:");
  console.log("  npx tsx src/pipeline/aggregate-stats.ts");
  console.log("  npx tsx src/pipeline/analyze-contract-network.ts");
  console.log("  npx tsx src/pipeline/calculate-scores-sql.ts");
}

main().catch((err) => {
  console.error("\nConsolidation failed:", err.message);
  process.exit(1);
});
