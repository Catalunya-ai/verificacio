/**
 * Menjometre Contractes.cat Data Sync Script
 *
 * Fetches public procurement contracts from the Socrata SODA API
 * dataset ybgg-dgi6 ("Contractació pública a Catalunya") and loads
 * them into your PostgreSQL database (DATABASE_URL) via psql, for performance.
 *
 * API: https://analisi.transparenciacatalunya.cat/resource/ybgg-dgi6.json
 * Data: ~1.65M contracts, 2015-2026
 *
 * Usage: npx tsx src/connectors/sync-contractes.ts [--full | --resume | --dry-run | --skip-aggregation]
 */

import { isPlaceholderBeneficiaryName } from "../lib/privacy";
import { createPsqlRunner, lastLine, type PsqlFailure } from "../lib/psql-runner";
import { slugifyContracts as slugify } from "../lib/slugify";
import { parseCif, parseAmount, parseYear, parseDate, esc, escNum } from "../lib/contractes-helpers";

// ============================================================
// SODA API types
// ============================================================

interface SodaContract {
  codi_expedient?: string;
  identificacio_adjudicatari?: string;
  denominacio_adjudicatari?: string;
  import_adjudicacio_sense?: string;
  import_adjudicacio_amb_iva?: string;
  data_adjudicacio_contracte?: string;
  data_formalitzacio_contracte?: string;
  data_publicacio_contracte?: string;
  nom_organ?: string;
  tipus_contracte?: string;
  procediment?: string;
  codi_cpv?: string;
  objecte_contracte?: string;
  ofertes_rebudes?: string;
  numero_lot?: string;
  enllac_publicacio?: { url?: string };
}

// ============================================================
// Constants
// ============================================================

const SODA_BASE = "https://analisi.transparenciacatalunya.cat/resource/ybgg-dgi6.json";
const BATCH_SIZE = 50000;
const SQL_BATCH = 5000; // rows per INSERT statement
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;
const FETCH_TIMEOUT_MS = 120_000; // 2 min — SODA gets slow at high offsets (8s+ at 400K)
const RATE_LIMIT_MS = 200;
let allowedPsqlFailureHandler: ((failure: PsqlFailure) => void) | undefined;
// Connection: DATABASE_URL (see src/lib/db.ts).
const { runSQL, runSQLFile } = createPsqlRunner({
  warnAllowedFailures: false,
  onAllowedFailure: (failure) => allowedPsqlFailureHandler?.(failure),
});

// ============================================================
// Helpers
// ============================================================

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// slugify: canonical contracts-pipeline implementation imported from
// ../lib/slugify (slugifyContracts) — frozen behavior, see module header.

// Pure parsers/escapers (parseCif, parseAmount, parseYear, parseDate, esc,
// escNum) live in ../lib/contractes-helpers — unit-tested, frozen behavior.

// ============================================================
// SODA API client
// ============================================================

async function fetchSodaPage(offset: number): Promise<SodaContract[]> {
  const params = new URLSearchParams({
    $limit: String(BATCH_SIZE),
    $offset: String(offset),
    $where: "(import_adjudicacio_sense is not null OR import_adjudicacio_amb_iva is not null)",
    $order: "codi_expedient ASC",
  });

  const url = `${SODA_BASE}?${params}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Manual timeout that covers both fetch + body read
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "Menjometre/1.0 (open data observatory)",
          },
          signal: controller.signal,
        });

        if (response.status === 429 || response.status >= 500) {
          clearTimeout(timer);
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          console.warn(`  SODA API ${response.status}, retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }

        if (!response.ok) {
          clearTimeout(timer);
          throw new Error(`SODA API error: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as SodaContract[];
        clearTimeout(timer);
        return data;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`  Fetch error: ${(err as Error).message}, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw new Error("Unreachable");
}

// ============================================================
// Bulk SQL insert logic
// ============================================================

function upsertEntitiesSQL(records: SodaContract[]): {
  count: number;
  cifToSlug: Map<string, string>;
  entityFallbackFailures: number;
} {
  const cifEntities = new Map<string, { slug: string; name: string; cif: string }>();
  const slugEntities = new Map<string, { slug: string; name: string }>();

  for (const record of records) {
    const name = record.denominacio_adjudicatari?.trim();
    if (!name) continue;
    // Skip CSV pointer phrases ("Veure documents adjunts", "Diverses empreses…",
    // "Hi ha 15 empreses adjudicatàries…") — these are not real beneficiaries
    // and would otherwise create ghost entities like VEURE-ELS-DOCUMENTS-ADJUNTS
    if (isPlaceholderBeneficiaryName(name)) continue;

    const cif = parseCif(record.identificacio_adjudicatari);
    const slug = slugify(name);

    if (cif) {
      // CIF-first: CIF is the authoritative identity
      if (!cifEntities.has(cif)) {
        cifEntities.set(cif, { slug, name, cif });
      }
    } else {
      // No CIF (masked or absent): slug fallback, only if not claimed by CIF
      if (!slugEntities.has(slug)) {
        slugEntities.set(slug, { slug, name });
      }
    }
  }

  // Remove slug entities that share a slug with a CIF entity (CIF wins)
  for (const cifEntity of cifEntities.values()) {
    slugEntities.delete(cifEntity.slug);
  }

  // Build CIF→slug map for contract slug resolution
  // First check DB for existing entities with these CIFs (RAISC canonical slugs)
  const allCifs = Array.from(cifEntities.keys());
  const cifToSlug = new Map<string, string>();

  for (let i = 0; i < allCifs.length; i += 300) {
    const chunk = allCifs.slice(i, i + 300);
    const cifList = chunk.map(c => esc(c)).join(",");
    const result = runSQL(`SELECT cif, slug FROM entities WHERE cif IN (${cifList});`);
    for (const line of result.split("\n").filter(l => l.includes("|"))) {
      const [cif, slug] = line.split("|").map(s => s.trim());
      if (cif && slug) cifToSlug.set(cif, slug);
    }
  }

  // For CIFs not in DB yet, use the slug from this batch
  for (const [cif, entity] of cifEntities) {
    if (!cifToSlug.has(cif)) {
      cifToSlug.set(cif, entity.slug);
    }
  }

  let total = 0;
  let entityFallbackFailures = 0;
  const entityFallbackFailureSamples: Array<{ slug: string; message: string }> = [];

  function recordEntityFallbackFailure(entity: { slug: string }, failure: PsqlFailure) {
    entityFallbackFailures += 1;
    if (entityFallbackFailureSamples.length < 3) {
      entityFallbackFailureSamples.push({
        slug: entity.slug,
        message: failure.message.replace(/\s+/g, " ").trim().slice(0, 240),
      });
    }
  }

  type CifEntity = { slug: string; name: string; cif: string };

  // VALUES list shared by the two steps of the fallback. The ::text casts on
  // the first row fix the column type of the whole list: esc() emits a bare
  // NULL for an absent value, which would otherwise stay `unknown`.
  //
  // Deduplicating by cif is not needed, and adding it would be dead code:
  // `cifEntities` is a Map keyed by CIF with first-wins insertion, so a chunk
  // cannot carry the same cif twice. Even if it did, `UPDATE ... FROM (VALUES ...)`
  // does not update the target row twice: Postgres picks one source row. The
  // only possible difference is which `name` wins when the stored one is NULL,
  // and the Map already applies the same rule as the per-row loop.
  function cifFallbackValues(chunk: CifEntity[]): string {
    return chunk
      .map((e, idx) =>
        idx === 0
          ? `(${esc(e.slug)}::text, ${esc(e.name)}::text, ${esc(e.cif)}::text)`
          : `(${esc(e.slug)}, ${esc(e.name)}, ${esc(e.cif)})`
      )
      .join(",\n");
  }

  // Same semantics as the per-row loop, in two statements over the whole
  // chunk. `ON CONFLICT DO NOTHING` WITHOUT an arbiter makes it possible: it
  // tolerates any uniqueness conflict (slug OR cif), which the main path,
  // which arbitrates on cif, cannot do.
  function cifFallbackBulkSQL(chunk: CifEntity[]): string {
    const values = cifFallbackValues(chunk);
    return `
      UPDATE entities SET
        name = CASE WHEN entities.name_source = 'raisc' THEN entities.name
                    ELSE COALESCE(entities.name, v.name) END
      FROM (VALUES ${values}) AS v(slug, name, cif)
      WHERE entities.cif = v.cif;

      INSERT INTO entities (slug, name, cif, name_source)
      SELECT v.slug, v.name, v.cif, 'contractes'
      FROM (VALUES ${values}) AS v(slug, name, cif)
      ON CONFLICT DO NOTHING;
    `;
  }

  // Last resort: the same statement pairs row by row, concatenated into ONE
  // invocation. With ON_ERROR_STOP the first failure stops the rest; the
  // earlier ones are already committed (psql runs in autocommit), so progress
  // up to the problem is kept.
  function cifFallbackPerRowSQL(chunk: CifEntity[]): string {
    return chunk
      .map(
        (e) =>
          `UPDATE entities SET name = CASE WHEN name_source = 'raisc' THEN name ELSE COALESCE(name, ${esc(e.name)}) END WHERE cif = ${esc(e.cif)};
           INSERT INTO entities (slug, name, cif, name_source) VALUES (${esc(e.slug)}, ${esc(e.name)}, ${esc(e.cif)}, 'contractes')
           ON CONFLICT DO NOTHING;`
      )
      .join("\n");
  }

  function runCifFallback(sql: string): PsqlFailure | null {
    let captured: PsqlFailure | null = null;
    allowedPsqlFailureHandler = (failure) => {
      captured = failure;
    };
    try {
      runSQLFile(sql, { allowFailure: true });
    } finally {
      allowedPsqlFailureHandler = undefined;
    }
    return captured;
  }

  // Pass 1: CIF entities FIRST (authoritative)
  const withCif = Array.from(cifEntities.values());
  for (let i = 0; i < withCif.length; i += SQL_BATCH) {
    const chunk = withCif.slice(i, i + SQL_BATCH);
    // Upsert by CIF — preserves existing slug and RAISC-sourced names
    const stmts = chunk.map(e =>
      `INSERT INTO entities (slug, name, cif, name_source) VALUES (${esc(e.slug)}, ${esc(e.name)}, ${esc(e.cif)}, 'contractes')
       ON CONFLICT (cif) WHERE cif IS NOT NULL DO UPDATE SET
         name = CASE WHEN entities.name_source = 'raisc' THEN entities.name
                     ELSE COALESCE(entities.name, EXCLUDED.name) END`
    ).join(";\n");
    try {
      runSQLFile(stmts + ";");
    } catch (err) {
      // Slug conflict — entity exists with this slug but different CIF.
      // Fall back to set-based updates by CIF (keep existing slug).
      //
      // A single statement cannot carry two ON CONFLICT clauses, and one psql
      // process per row would be far too slow on a full load, so the fallback
      // is set-based first and row-by-row (in one invocation) only if needed.
      console.warn(`  CIF entity bulk upsert fell back to set-based path: ${(err as Error).message.slice(0, 180)}`);
      let fallbackFailure = runCifFallback(cifFallbackBulkSQL(chunk));
      if (fallbackFailure) {
        console.warn(
          `  Set-based fallback failed; retrying row-by-row in one invocation: ${fallbackFailure.message.replace(/\s+/g, " ").trim().slice(0, 180)}`
        );
        fallbackFailure = runCifFallback(cifFallbackPerRowSQL(chunk));
      }
      if (fallbackFailure) {
        // It can no longer be attributed to one row: if both paths failed,
        // the whole chunk failed and is counted that way. The guard below
        // (>100 or >25%) stops the sync, which is what must happen.
        for (const e of chunk) recordEntityFallbackFailure(e, fallbackFailure);
      }
    }
    total += chunk.length;
  }

  if (entityFallbackFailures > 0) {
    const samples = entityFallbackFailureSamples
      .map((sample) => `${sample.slug}: ${sample.message}`)
      .join(" | ");
    console.warn(`  CIF entity per-row fallback tolerated ${entityFallbackFailures} failures. Samples: ${samples}`);
  }
  if (entityFallbackFailures > 100 || entityFallbackFailures > withCif.length * 0.25) {
    throw new Error(
      `CIF entity per-row fallback failed for ${entityFallbackFailures}/${withCif.length} entities`
    );
  }

  // Pass 2: No-CIF entities — only create if slug doesn't exist
  const withoutCif = Array.from(slugEntities.values());
  for (let i = 0; i < withoutCif.length; i += SQL_BATCH) {
    const chunk = withoutCif.slice(i, i + SQL_BATCH);
    const values = chunk.map(e =>
      `(${esc(e.slug)}, ${esc(e.name)})`
    ).join(",\n");

    const sql = `
      INSERT INTO entities (slug, name)
      VALUES ${values}
      ON CONFLICT (slug) DO NOTHING;
    `;
    runSQLFile(sql);
    total += chunk.length;
  }

  return { count: total, cifToSlug, entityFallbackFailures };
}

interface ContractRow {
  entity_slug: string;
  cif: string | null;
  codi_expedient: string | null;
  lot_number: string;
  amount: number | null;
  amount_with_vat: number | null;
  contract_year: number | null;
  contract_date: string | null;
  organ: string | null;
  contract_type: string | null;
  procedure_type: string | null;
  cpv_code: string | null;
  description: string | null;
  num_bidders: number | null;
  publication_url: string | null;
}

function insertContractsSQL(records: SodaContract[], cifToSlug: Map<string, string>): { processed: number; skipped: number } {
  const contracts: ContractRow[] = [];

  for (const record of records) {
    const name = record.denominacio_adjudicatari?.trim();
    if (!name) continue;
    // Skip pointer-phrase beneficiaries — see upsertEntitiesSQL. Dropping the
    // contract row too means the organ's totals won't include an
    // unattributable amount pointing at a ghost beneficiary.
    if (isPlaceholderBeneficiaryName(name)) continue;

    // Only use import_adjudicacio_sense (excl. VAT) for the amount column.
    // Never fall back to import_adjudicacio_amb_iva — mixing VAT-inclusive and
    // VAT-exclusive amounts in the same column corrupts aggregations and scoring.
    const amount = parseAmount(record.import_adjudicacio_sense);
    const amountWithVat = parseAmount(record.import_adjudicacio_amb_iva);
    if (!amount && !amountWithVat) continue;

    const cif = parseCif(record.identificacio_adjudicatari);
    const slug = slugify(name);

    // CIF-first: if entity exists with this CIF, use its canonical slug
    const canonicalSlug = (cif && cifToSlug.get(cif)) || slug;

    // Use fallback dates: adjudicació > formalització > publicació
    const contractDateStr = record.data_adjudicacio_contracte
      || record.data_formalitzacio_contracte
      || record.data_publicacio_contracte;

    contracts.push({
      entity_slug: canonicalSlug,
      cif,
      codi_expedient: record.codi_expedient || null,
      lot_number: record.numero_lot?.trim() || '',
      amount,
      amount_with_vat: amountWithVat,
      contract_year: parseYear(contractDateStr),
      contract_date: parseDate(contractDateStr),
      organ: record.nom_organ || null,
      contract_type: record.tipus_contracte || null,
      procedure_type: record.procediment || null,
      cpv_code: record.codi_cpv || null,
      description: record.objecte_contracte || null,
      num_bidders: record.ofertes_rebudes ? parseInt(record.ofertes_rebudes, 10) || null : null,
      publication_url: record.enllac_publicacio?.url || null,
    });
  }

  // Deduplicate by CIF or the compact no-CIF slug conflict key
  const seen = new Set<string>();
  const seenHistorical = new Set<string>();
  const unique = contracts.filter((c) => {
    if (!c.codi_expedient) return true;
    const key = c.cif
      ? `${c.codi_expedient}|${c.cif}|${c.lot_number}`
      : JSON.stringify([c.codi_expedient, c.entity_slug.replace(/[^A-Z0-9]/g, ""), c.lot_number, c.organ, c.amount]);
    // The historical unique index also permits only one row per exact slug.
    const historicalKey = c.cif ? null : JSON.stringify([c.codi_expedient, c.entity_slug, c.lot_number]);
    if (seen.has(key) || (historicalKey && seenHistorical.has(historicalKey))) return false;
    seen.add(key);
    if (historicalKey) seenHistorical.add(historicalKey);
    return true;
  });

  const skipped = contracts.length - unique.length;

  if (unique.length === 0) return { processed: 0, skipped };

  let processed = 0;

  // Split into CIF and no-CIF for two-tier dedup
  const cifContracts = unique.filter(c => c.cif);
  const noCifContracts = unique.filter(c => !c.cif);

  const COLUMNS = `(entity_slug, cif, codi_expedient, lot_number,
        amount, amount_with_vat,
        contract_year, contract_date,
        organ, contract_type, procedure_type,
        cpv_code, description, num_bidders, publication_url)`;

  function formatValues(chunk: ContractRow[]): string {
    return chunk.map(c =>
      `(${esc(c.entity_slug)}, ${esc(c.cif)}, ${esc(c.codi_expedient)}, ${esc(c.lot_number)}, ` +
      `${escNum(c.amount)}, ${escNum(c.amount_with_vat)}, ` +
      `${escNum(c.contract_year)}, ${c.contract_date ? esc(c.contract_date) : "NULL"}, ` +
      `${esc(c.organ)}, ${esc(c.contract_type)}, ${esc(c.procedure_type)}, ` +
      `${esc(c.cpv_code)}, ${esc(c.description)}, ${escNum(c.num_bidders)}, ${esc(c.publication_url)})`
    ).join(",\n");
  }

  // CIF contracts: dedup by (codi_expedient, cif, lot_number)
  // `superseded = false` below re-activates a superseded row on re-sync, except for known alias
  // expedients: trigger trg_contracts_enforce_expedient_alias (contract_expedient_aliases) writes
  // those as superseded again.
  for (let i = 0; i < cifContracts.length; i += SQL_BATCH) {
    const chunk = cifContracts.slice(i, i + SQL_BATCH);
    const sql = `
      INSERT INTO contracts ${COLUMNS}
      VALUES ${formatValues(chunk)}
      ON CONFLICT (codi_expedient, cif, lot_number)
      WHERE codi_expedient IS NOT NULL AND cif IS NOT NULL AND cif != ''
      DO UPDATE SET amount = EXCLUDED.amount, amount_with_vat = EXCLUDED.amount_with_vat,
        num_bidders = EXCLUDED.num_bidders, superseded = false;
    `;
    runSQLFile(sql);
    processed += chunk.length;
  }

  // No-CIF contracts: dedup by the compact entity slug, then by the historical
  // (codi_expedient, entity_slug, lot_number) index. Same as above:
  // `superseded = false` does not revive known alias expedients
  // (trg_contracts_enforce_expedient_alias).
  for (let i = 0; i < noCifContracts.length; i += SQL_BATCH) {
    const chunk = noCifContracts.slice(i, i + SQL_BATCH);
    const sql = `
      BEGIN;
      CREATE TEMP TABLE incoming_contracts (LIKE public.contracts INCLUDING DEFAULTS) ON COMMIT DROP;
      INSERT INTO incoming_contracts ${COLUMNS} VALUES ${formatValues(chunk)};

      -- The compact key catches historical slug variants. Update those rows first.
      UPDATE contracts target SET
        entity_slug = CASE
          WHEN EXISTS (
            SELECT 1 FROM contracts occupied
            WHERE occupied.codi_expedient = incoming.codi_expedient
              AND occupied.entity_slug = incoming.entity_slug
              AND occupied.lot_number = incoming.lot_number
              AND (occupied.cif IS NULL OR occupied.cif = '')
              AND occupied.id <> target.id
          ) THEN target.entity_slug ELSE incoming.entity_slug END,
        entity_id = COALESCE((SELECT e.id FROM entities e WHERE e.slug = incoming.entity_slug), target.entity_id),
        amount_with_vat = incoming.amount_with_vat,
        num_bidders = incoming.num_bidders,
        superseded = false
      FROM incoming_contracts incoming
      WHERE target.codi_expedient = incoming.codi_expedient
        AND target.lot_number = incoming.lot_number
        AND COALESCE(target.source_dataset, '') = COALESCE(incoming.source_dataset, '')
        AND COALESCE(target.organ, '') = COALESCE(incoming.organ, '')
        AND COALESCE(target.amount, 'NaN'::numeric) = COALESCE(incoming.amount, 'NaN'::numeric)
        AND regexp_replace(target.entity_slug, '[^A-Z0-9]', '', 'g') = regexp_replace(incoming.entity_slug, '[^A-Z0-9]', '', 'g')
        AND (target.cif IS NULL OR target.cif = '')
        AND target.superseded IS NOT TRUE;

      -- The historical exact-slug index still handles corrected amounts or organs.
      INSERT INTO contracts ${COLUMNS}
      SELECT ${COLUMNS.slice(1, -1)} FROM incoming_contracts incoming
      WHERE NOT EXISTS (
        SELECT 1 FROM contracts existing
        WHERE existing.codi_expedient = incoming.codi_expedient
          AND existing.lot_number = incoming.lot_number
          AND COALESCE(existing.source_dataset, '') = COALESCE(incoming.source_dataset, '')
          AND COALESCE(existing.organ, '') = COALESCE(incoming.organ, '')
          AND COALESCE(existing.amount, 'NaN'::numeric) = COALESCE(incoming.amount, 'NaN'::numeric)
          AND regexp_replace(existing.entity_slug, '[^A-Z0-9]', '', 'g') = regexp_replace(incoming.entity_slug, '[^A-Z0-9]', '', 'g')
          AND (existing.cif IS NULL OR existing.cif = '')
          AND existing.superseded IS NOT TRUE
      )
      ON CONFLICT (codi_expedient, entity_slug, lot_number)
      WHERE codi_expedient IS NOT NULL AND (cif IS NULL OR cif = '')
      DO UPDATE SET entity_id = COALESCE((SELECT e.id FROM entities e WHERE e.slug = EXCLUDED.entity_slug), contracts.entity_id),
        amount = EXCLUDED.amount, amount_with_vat = EXCLUDED.amount_with_vat,
        num_bidders = EXCLUDED.num_bidders,
        superseded = false;
      COMMIT;
    `;
    runSQLFile(sql);
    processed += chunk.length;
  }

  return { processed, skipped };
}

// ============================================================
// Aggregation
// ============================================================

function aggregateContractStats() {
  console.log("\n=== Aggregating contract stats via SQL ===");

  // Official annulments: a contract stored from an annulment line must not count as an award. The
  // upserts above set such rows live again, so the stored decisions (contract_annulment_decisions)
  // are applied before the sweeps below read the live rows, and once more after the alias detection.
  // Refreshing the lines and the decisions themselves is the job of the annulment load script: run
  // it after each contracts load.
  console.log("  Official annulment decisions (before the sweeps)...");
  const annulBefore = lastLine(runSQL("SELECT rows_superseded, rows_unsuperseded FROM apply_contract_annulments();"));
  const [annulBeforeSuperseded, annulBeforeLive] = annulBefore.split("|");
  console.log(`    → ${annulBeforeSuperseded} rows superseded, ${annulBeforeLive} rows set live`);

  // Dedup: mark alternative-expedient duplicates as superseded
  // Uses EXISTS (faster than ROW_NUMBER), description matching to prevent false positives
  console.log("  Dedup: marking alternative-expedient duplicates...");
  // IS NOT DISTINCT FROM: NULL=NULL matches, but NULL≠non-NULL prevents false positives.
  // Explicit transaction so advisory lock is held during the UPDATE.
  const dedupResult = runSQL(`
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
  console.log(`    → ${dedupResult || 0} alt-expedient duplicates superseded`);

  // Mark empty-lot summary rows as superseded where lot-specific rows exist
  console.log("  Marking empty-lot duplicates as superseded (CIF-based)...");
  runSQL(`
    UPDATE contracts c
    SET superseded = true
    WHERE c.lot_number = '' AND c.superseded IS NOT TRUE
      AND c.codi_expedient IS NOT NULL AND c.cif IS NOT NULL AND c.cif != ''
      AND EXISTS (
        SELECT 1 FROM contracts c2
        WHERE c2.codi_expedient = c.codi_expedient
          AND c2.cif = c.cif
          AND c2.lot_number != ''
          AND c2.superseded IS NOT TRUE
      );
  `);
  console.log("  Marking empty-lot duplicates as superseded (slug fallback)...");
  runSQL(`
    UPDATE contracts c
    SET superseded = true
    WHERE c.lot_number = '' AND c.superseded IS NOT TRUE
      AND c.codi_expedient IS NOT NULL AND (c.cif IS NULL OR c.cif = '')
      AND EXISTS (
        SELECT 1 FROM contracts c2
        WHERE c2.codi_expedient = c.codi_expedient
          AND c2.entity_slug = c.entity_slug
          AND c2.lot_number != ''
          AND c2.superseded IS NOT TRUE
      );
  `);

  // Rule-based expedient aliases: the same contract published under two expedient codes that the
  // generic dedup above cannot see (different descriptions). Detects the pairs by rule
  // (contract_expedient_aliases.rule), records the alias and supersedes the copy that has a live
  // canonical twin. After the three dedup sweeps, so it works on the final set of live rows.
  console.log("  Rule-based expedient aliases (contract_expedient_aliases)...");
  const aliasCounts = lastLine(runSQL("SELECT * FROM detect_contract_expedient_aliases();"));
  const [aliasesAdded, aliasRowsSuperseded] = aliasCounts.split("|");
  console.log(`    → ${aliasesAdded} aliases added, ${aliasRowsSuperseded} contract rows superseded`);

  // The alias detection can set rows live that an annulment decision keeps superseded, and the other
  // way round: apply the decisions again, last.
  console.log("  Official annulment decisions (after the alias detection)...");
  const annulAfter = lastLine(runSQL("SELECT rows_superseded, rows_unsuperseded FROM apply_contract_annulments();"));
  const [annulAfterSuperseded, annulAfterLive] = annulAfter.split("|");
  console.log(`    → ${annulAfterSuperseded} rows superseded, ${annulAfterLive} rows set live`);

  // The contract entity_id backfill runs in aggregate-stats.ts Step 3c.
  // Aggregation delegated to aggregate-stats.ts (uses entity_id, avoids CIF+slug double-counting)
  console.log("  Skipping inline aggregation — run aggregate-stats.ts after sync.");

  // Refresh the materialised views that read contracts (definitions in sql/matviews/).
  console.log("  Refreshing materialized views...");
  const matviews = ["contract_yearly_stats_mv"];
  for (const mv of matviews) {
    try {
      runSQL(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv};`);
      console.log(`    ${mv} refreshed`);
    } catch (err) {
      console.warn(`    ${mv} refresh skipped: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  console.log("  Aggregation complete");
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isFull = args.includes("--full");
  const skipAggregation = args.includes("--skip-aggregation");

  console.log("=== Menjometre Contractes.cat Data Sync (SQL mode) ===");
  console.log(`Source: SODA API (dataset ybgg-dgi6)`);
  console.log(`Mode: ${isDryRun ? "dry-run" : isFull ? "full" : "resume"}`);
  console.log(`Batch size: ${BATCH_SIZE} (API) / ${SQL_BATCH} (SQL insert)`);

  // Fetch first batch
  console.log("\nFetching first batch...");
  const firstBatch = await fetchSodaPage(0);
  console.log(`First batch: ${firstBatch.length} records`);

  if (isDryRun) {
    console.log("\n=== DRY RUN: Sample records ===");
    for (const record of firstBatch.slice(0, 5)) {
      const cif = parseCif(record.identificacio_adjudicatari);
      console.log(`  ${record.data_adjudicacio_contracte?.substring(0, 10)} | ${cif || "NO-CIF"} | ${record.denominacio_adjudicatari?.substring(0, 40)} | EUR${record.import_adjudicacio_sense} | ${record.nom_organ?.substring(0, 30)}`);
    }

    const countUrl = `${SODA_BASE}?$select=count(*) as cnt&$where=(import_adjudicacio_sense is not null OR import_adjudicacio_amb_iva is not null)`;
    const countResp = await fetch(countUrl);
    const countData = await countResp.json();
    console.log(`\nTotal matching records: ${Number(countData[0]?.cnt ?? 0).toLocaleString()}`);
    console.log("Dry run complete. No data written.");
    return;
  }

  // Advisory lock — prevent concurrent sync runs
  const lockResult = runSQL("SELECT pg_try_advisory_lock(hashtext('sync_contractes'));").trim();
  if (lockResult !== "t") {
    console.error("Another contractes sync is already running. Exiting.");
    process.exit(1);
  }

  // Create sync log entry
  const syncIdRaw = runSQL(`
    INSERT INTO data_sync_log (data_source, status)
    VALUES ('contractes_cat', 'running')
    RETURNING id;
  `).trim();
  // psql -t -A may append "INSERT 0 1" tag — take first line only
  const syncId = syncIdRaw.split("\n")[0].trim();
  console.log(`Sync log ID: ${syncId}`);

  // Determine resume offset
  let startOffset = 0;
  if (!isFull) {
    const lastOffset = runSQL(`
      SELECT last_offset FROM data_sync_log
      WHERE data_source = 'contractes_cat'
        AND status IN ('completed', 'failed')
        AND id != '${syncId}'
      ORDER BY started_at DESC LIMIT 1;
    `).trim();
    if (lastOffset && parseInt(lastOffset) > 0) {
      startOffset = parseInt(lastOffset);
      console.log(`Resuming from checkpoint offset ${startOffset.toLocaleString()}`);
    } else {
      // Fallback to COUNT(*) heuristic
      const existing = runSQL("SELECT COUNT(*) FROM contracts;");
      const existingCount = parseInt(existing) || 0;
      if (existingCount > 0) {
        startOffset = Math.floor(existingCount / BATCH_SIZE) * BATCH_SIZE;
        console.log(`Resuming from offset ${startOffset.toLocaleString()} (${existingCount.toLocaleString()} existing contracts, no checkpoint found)`);
      }
    }
  }

  const startTime = Date.now();

  try {
    let totalFetched = 0;
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalEntityFallbackFailures = 0;
    let offset = startOffset;

    while (true) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`\nOffset ${offset.toLocaleString()} [${elapsed}s]...`);

      const batch = offset === 0 && startOffset === 0 ? firstBatch : await fetchSodaPage(offset);

      if (batch.length === 0) {
        console.log("Empty batch, stopping.");
        break;
      }

      totalFetched += batch.length;
      console.log(`  Fetched ${batch.length} records (total: ${totalFetched.toLocaleString()})`);

      // Upsert entities via SQL (CIF-first)
      const { count: entityCount, cifToSlug, entityFallbackFailures } = upsertEntitiesSQL(batch);
      totalEntityFallbackFailures += entityFallbackFailures;
      console.log(`  Upserted ${entityCount} entities (${cifToSlug.size} CIF-mapped)`);

      // Insert contracts via SQL (using canonical slugs from CIF lookup)
      const { processed, skipped } = insertContractsSQL(batch, cifToSlug);
      totalProcessed += processed;
      totalSkipped += skipped;
      console.log(`  Inserted ${processed} contracts (dedup skipped: ${skipped})`);

      offset += batch.length;

      // Checkpoint to sync log
      const cpResult = runSQL(`
        UPDATE data_sync_log SET
          records_fetched = ${totalFetched},
          records_processed = ${totalProcessed},
          records_skipped = ${totalSkipped},
          last_offset = ${offset}
        WHERE id = '${syncId}'
        RETURNING id;
      `);
      if (!cpResult) console.warn("  ⚠ Sync log checkpoint write failed");

      // Rate limit
      await sleep(RATE_LIMIT_MS);

      if (batch.length < BATCH_SIZE) break;
    }

    // Aggregate
    if (!skipAggregation) {
      aggregateContractStats();
    } else {
      console.log("\n=== Skipping aggregation (--skip-aggregation) ===");
    }

    const activeOrphans = parseInt(
      runSQL("SELECT COUNT(*) FROM contracts WHERE entity_id IS NULL AND superseded IS NOT TRUE;").trim(),
      10
    ) || 0;
    if (activeOrphans > 5000) {
      console.error("\n=== CONTRACT ENTITY_ID ORPHAN CHECK ===");
      console.error(`Active contracts without entity_id: ${activeOrphans.toLocaleString()} (threshold: 5,000; a healthy full load leaves about 1,000)`);
      console.error("A silent entity backfill failure would leave contracts out of every entity total.");
      throw new Error(`contractes sync produced ${activeOrphans} active entity_id orphans`);
    }

    // Mark sync complete
    runSQL(`
      UPDATE data_sync_log SET
        status = 'completed',
        completed_at = NOW(),
        records_fetched = ${totalFetched},
        records_processed = ${totalProcessed},
        records_skipped = ${totalSkipped},
        last_offset = ${offset}
      WHERE id = '${syncId}';
    `);

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("\n=== Sync Summary ===");
    console.log(`Records fetched: ${totalFetched.toLocaleString()}`);
    console.log(`Records processed: ${totalProcessed.toLocaleString()}`);
    console.log(`Records skipped (dedup): ${totalSkipped.toLocaleString()}`);
    console.log(`Entity fallback failures: ${totalEntityFallbackFailures.toLocaleString()}`);
    console.log(`Time: ${totalElapsed}s`);
    console.log("Status: COMPLETED");

    // Verify
    const finalCount = runSQL("SELECT COUNT(*) FROM contracts;");
    console.log(`Contracts in DB: ${parseInt(finalCount).toLocaleString()}`);

    // Inline freshness check
    await checkFreshness();
  } catch (err) {
    console.error("\n=== Sync FAILED ===", err);
    // Mark sync as failed in log
    try {
      runSQL(`
        UPDATE data_sync_log SET
          status = 'failed',
          completed_at = NOW(),
          error_message = ${esc((err as Error).message?.substring(0, 500))}
        WHERE id = '${syncId}';
      `);
    } catch (logErr) {
      console.warn(`  Failed to mark sync as failed: ${(logErr as Error).message}`);
    }
    process.exit(1);
  } finally {
    // Release advisory lock
    try {
      runSQL("SELECT pg_advisory_unlock(hashtext('sync_contractes'));");
    } catch (unlockErr) {
      console.warn(`  Failed to release sync advisory lock: ${(unlockErr as Error).message}`);
    }
  }
}

// ============================================================
// Freshness check — runs after successful sync
// ============================================================

async function checkFreshness() {
  try {
    const localCount = parseInt(
      runSQL("SELECT COUNT(*) FROM contracts WHERE superseded IS NOT TRUE;").trim()
    );

    const sodaResp = await fetch(
      `${SODA_BASE}?$select=count(*)&$where=(import_adjudicacio_sense is not null OR import_adjudicacio_amb_iva is not null)`,
      { signal: AbortSignal.timeout(30_000) }
    );
    const sodaData = await sodaResp.json();
    const sodaCount = parseInt(sodaData[0]?.count ?? "0");

    const gap = Math.abs(sodaCount - localCount);
    const gapPct = sodaCount > 0 ? ((gap / sodaCount) * 100).toFixed(1) : "0.0";

    const latestLocal = runSQL(
      "SELECT MAX(contract_date) FROM contracts;"
    ).trim();

    console.log("\n=== Freshness Check ===");
    console.log(`  Local: ${localCount.toLocaleString()} | SODA: ${sodaCount.toLocaleString()} | Gap: ${gap.toLocaleString()} (${gapPct}%)`);
    console.log(`  Latest local contract date: ${latestLocal}`);

    if (gap > 10000 || parseFloat(gapPct) > 2.0) {
      console.error(`  ⚠ FRESHNESS ALERT: Gap exceeds threshold (${gap.toLocaleString()} / ${gapPct}%)`);
    } else {
      console.log("  ✓ Freshness within acceptable range");
    }
  } catch (err) {
    console.warn(`  Freshness check failed: ${(err as Error).message}`);
  }
}

main();
