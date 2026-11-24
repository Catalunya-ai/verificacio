/**
 * Menjometre Convenis Data Sync Script
 *
 * Fetches public cooperation agreements from the Socrata SODA API
 * dataset exh2-diuf ("Convenis de la Generalitat de Catalunya") and loads
 * them into your PostgreSQL database (DATABASE_URL) via psql, for performance.
 *
 * API: https://analisi.transparenciacatalunya.cat/resource/exh2-diuf.json
 * Data: ~53K convenis, 1982-2026
 *
 * Usage: npx tsx src/connectors/sync-convenis.ts [--full | --resume | --dry-run | --skip-aggregation]
 */

import { execSync } from "child_process";
import { libpqEnv } from "../lib/db";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ============================================================
// SODA API types
// ============================================================

interface SodaConveni {
  n_mero_conveni_definitiu?: string;
  t_tol_conveni?: string;
  objecte?: string;
  mat_ria?: string;
  codi_secci?: string;
  secci?: string;
  organismes_signants_per_part?: string;
  organismes_signants_ens_locals?: string;
  altres_organismes_signants?: string;
  codi_aoc_organismes_signants?: string;
  total_aportacions_previstes?: string;   // Generalitat amount
  total_aportacions_previstes_1?: string; // Local entity amount
  total_aportacions_previstes_2?: string; // Other entity amount
  sumatori_aportacions_totals?: string;   // Total amount
  data_signatura?: string;
  data_vigencia?: string;
  vigent?: string;
  prorrogable?: string;
  desc_rrega_pdf_conveni?: string;
}

// ============================================================
// Constants
// ============================================================

const SODA_BASE = "https://analisi.transparenciacatalunya.cat/resource/exh2-diuf.json";
const BATCH_SIZE = 50000;
const SQL_BATCH = 5000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const RATE_LIMIT_MS = 200;
// The connection travels as libpq variables (DATABASE_URL, see src/lib/db.ts).
const PSQL = "psql -X -t -A";
const psqlEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...libpqEnv() });

// ============================================================
// Helpers
// ============================================================

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(name: string): string {
  return name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bS\.\s*A\.\s*U\b\.?/g, "SAU")
    .replace(/\bS\.\s*A\b\.?/g, "SA")
    .replace(/\bS\.\s*L\.\s*U\b\.?/g, "SLU")
    .replace(/\bS\.\s*L\b\.?/g, "SL")
    .replace(/\bS\.\s*C\.\s*C\.\s*L\b\.?/g, "SCCL")
    .replace(/\bS\.\s*C\.\s*P\b\.?/g, "SCP")
    .replace(/\bS\.\s*C\b\.?/g, "SC")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseAmount(val: string | undefined): number | null {
  if (!val) return null;
  const num = parseFloat(val);
  return isNaN(num) || num < 0 ? null : num;
}

function parseYear(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const year = parseInt(dateStr.substring(0, 4), 10);
  return isNaN(year) || year < 1980 || year > 2030 ? null : year;
}

function parseDate(dateStr: string | undefined): string | null {
  if (!dateStr) return null;
  const match = dateStr.match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) return null;
  const year = parseInt(match[0].substring(0, 4), 10);
  if (year < 1980 || year > 2030) return null;
  return match[0];
}

function esc(val: string | null | undefined): string {
  if (val === null || val === undefined) return "NULL";
  return "'" + val.replace(/'/g, "''").replace(/\\/g, "\\\\") + "'";
}

function escNum(val: number | null): string {
  if (val === null || val === undefined) return "NULL";
  return String(val);
}

function escBool(val: boolean | null): string {
  if (val === null || val === undefined) return "NULL";
  return val ? "TRUE" : "FALSE";
}

function runSQL(sql: string): string {
  try {
    const result = execSync(
      PSQL,
      { input: sql, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024, env: psqlEnv() }
    );
    return result.toString().trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString().trim() || "";
    if (stderr && !stderr.includes("NOTICE")) {
      console.error(`  SQL error: ${stderr.substring(0, 200)}`);
    }
    return e.stdout?.toString().trim() || "";
  }
}

function runSQLFile(sql: string): string {
  const tmpFile = join(tmpdir(), `menjometre_convenis_${Date.now()}.sql`);
  try {
    writeFileSync(tmpFile, sql);
    const result = execSync(
      `cat "${tmpFile}" | ${PSQL}`,
      { stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024, env: psqlEnv() }
    );
    return result.toString().trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString().trim() || "";
    if (stderr && !stderr.includes("NOTICE") && !stderr.includes("duplicate key")) {
      console.error(`  SQL file error: ${stderr.substring(0, 300)}`);
    }
    return e.stdout?.toString().trim() || "";
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ============================================================
// SODA API client
// ============================================================

async function fetchSodaPage(offset: number): Promise<SodaConveni[]> {
  const params = new URLSearchParams({
    $limit: String(BATCH_SIZE),
    $offset: String(offset),
    $order: ":id",
  });

  const url = `${SODA_BASE}?${params}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Menjometre/1.0 (open data observatory)",
        },
      });

      if (response.status === 429 || response.status >= 500) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`  SODA API ${response.status}, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        throw new Error(`SODA API error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as SodaConveni[];
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
// Signatory parsing
// ============================================================

/**
 * Parse semicolon-separated signatory names from a raw string.
 * Returns trimmed, non-empty names.
 */
function parseSignatories(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ============================================================
// Bulk SQL insert logic
// ============================================================

interface ConveniRow {
  entity_slug: string;
  entity_name: string;
  conveni_number: string | null;
  title: string | null;
  purpose: string | null;
  category: string | null;
  section_code: string | null;
  section: string | null;
  signatory_department: string | null;
  signatory_local_entities: string | null;
  signatory_others: string | null;
  aoc_codes: string | null;
  amount_generalitat: number | null;
  amount_local: number | null;
  amount_other: number | null;
  amount_total: number | null;
  signature_date: string | null;
  signature_year: number | null;
  expiry_date: string | null;
  is_active: boolean | null;
  is_renewable: boolean | null;
  document_url: string | null;
}

function processRecords(records: SodaConveni[]): ConveniRow[] {
  const rows: ConveniRow[] = [];

  for (const record of records) {
    const conveniNumber = record.n_mero_conveni_definitiu?.trim() || null;
    const amountGen = parseAmount(record.total_aportacions_previstes);
    const amountLocal = parseAmount(record.total_aportacions_previstes_1);
    const amountOther = parseAmount(record.total_aportacions_previstes_2);
    const amountTotal = parseAmount(record.sumatori_aportacions_totals);

    const localSignatories = parseSignatories(record.organismes_signants_ens_locals);
    const otherSignatories = parseSignatories(record.altres_organismes_signants);

    const signatureDate = parseDate(record.data_signatura);
    const signatureYear = parseYear(record.data_signatura);
    const expiryDate = parseDate(record.data_vigencia);
    const isActive = record.vigent === "Sí" ? true : record.vigent === "No" ? false : null;
    const isRenewable = record.prorrogable === "Sí" ? true : record.prorrogable === "No" ? false : null;

    const baseRow = {
      conveni_number: conveniNumber,
      title: record.t_tol_conveni?.trim() || null,
      purpose: record.objecte?.trim() || null,
      category: record.mat_ria?.trim() || null,
      section_code: record.codi_secci?.trim() || null,
      section: record.secci?.trim() || null,
      signatory_department: record.organismes_signants_per_part?.trim() || null,
      signatory_local_entities: record.organismes_signants_ens_locals?.trim() || null,
      signatory_others: record.altres_organismes_signants?.trim() || null,
      aoc_codes: record.codi_aoc_organismes_signants?.trim() || null,
      amount_generalitat: amountGen,
      signature_date: signatureDate,
      signature_year: signatureYear,
      expiry_date: expiryDate,
      is_active: isActive,
      is_renewable: isRenewable,
      document_url: record.desc_rrega_pdf_conveni?.trim() || null,
    };

    // Create one row per non-Generalitat signatory
    // Financial attribution: exact-only (single signatory of type gets per-type amount)
    const localCount = localSignatories.length;
    const otherCount = otherSignatories.length;

    for (const name of localSignatories) {
      const slug = slugify(name);
      if (!slug) continue;
      rows.push({
        ...baseRow,
        entity_slug: slug,
        entity_name: name,
        amount_local: amountLocal,
        amount_other: null,
        // Single local signatory: exact attribution of local amount
        // Multiple: NULL (unknown per-entity split)
        amount_total: localCount === 1 ? (amountLocal ?? null) : null,
      });
    }

    for (const name of otherSignatories) {
      const slug = slugify(name);
      if (!slug) continue;
      rows.push({
        ...baseRow,
        entity_slug: slug,
        entity_name: name,
        amount_local: null,
        amount_other: amountOther,
        // Single other signatory: exact attribution of other amount
        // Multiple: NULL (unknown per-entity split)
        amount_total: otherCount === 1 ? (amountOther ?? null) : null,
      });
    }

    // If no non-Generalitat signatories found, skip (inter-department only)
  }

  return rows;
}

function upsertEntitiesSQL(rows: ConveniRow[]): number {
  const entityMap = new Map<string, { slug: string; name: string }>();

  for (const row of rows) {
    if (!entityMap.has(row.entity_slug)) {
      entityMap.set(row.entity_slug, { slug: row.entity_slug, name: row.entity_name });
    }
  }

  const entities = Array.from(entityMap.values());
  if (entities.length === 0) return 0;

  // No CIF available — slug-only entity upsert
  for (let i = 0; i < entities.length; i += SQL_BATCH) {
    const chunk = entities.slice(i, i + SQL_BATCH);
    const values = chunk.map(e =>
      `(${esc(e.slug)}, ${esc(e.name)})`
    ).join(",\n");

    const sql = `
      INSERT INTO entities (slug, name)
      VALUES ${values}
      ON CONFLICT (slug) DO NOTHING;
    `;
    runSQLFile(sql);
  }

  return entities.length;
}

function insertConvenisSQL(rows: ConveniRow[]): { processed: number; skipped: number } {
  // Deduplicate in-memory: one row per conveni per entity
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    if (!r.conveni_number) return true; // keep records without conveni number
    const key = `${r.conveni_number}|${r.entity_slug}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const skipped = rows.length - unique.length;
  if (unique.length === 0) return { processed: 0, skipped };

  let processed = 0;

  const COLUMNS = `(entity_slug, conveni_number, title, purpose, category,
    section_code, section, signatory_department, signatory_local_entities,
    signatory_others, aoc_codes, amount_generalitat, amount_local,
    amount_other, amount_total, signature_date, signature_year,
    expiry_date, is_active, is_renewable, document_url)`;

  for (let i = 0; i < unique.length; i += SQL_BATCH) {
    const chunk = unique.slice(i, i + SQL_BATCH);
    const values = chunk.map(r =>
      `(${esc(r.entity_slug)}, ${esc(r.conveni_number)}, ${esc(r.title)}, ${esc(r.purpose)}, ${esc(r.category)}, ` +
      `${esc(r.section_code)}, ${esc(r.section)}, ${esc(r.signatory_department)}, ${esc(r.signatory_local_entities)}, ` +
      `${esc(r.signatory_others)}, ${esc(r.aoc_codes)}, ${escNum(r.amount_generalitat)}, ${escNum(r.amount_local)}, ` +
      `${escNum(r.amount_other)}, ${escNum(r.amount_total)}, ${r.signature_date ? esc(r.signature_date) : "NULL"}, ${escNum(r.signature_year)}, ` +
      `${r.expiry_date ? esc(r.expiry_date) : "NULL"}, ${escBool(r.is_active)}, ${escBool(r.is_renewable)}, ${esc(r.document_url)})`
    ).join(",\n");

    const sql = `
      INSERT INTO convenis ${COLUMNS}
      VALUES ${values}
      ON CONFLICT (conveni_number, entity_slug)
      WHERE conveni_number IS NOT NULL
      DO UPDATE SET
        title = EXCLUDED.title,
        amount_total = EXCLUDED.amount_total,
        is_active = EXCLUDED.is_active;
    `;
    runSQLFile(sql);
    processed += chunk.length;
  }

  return { processed, skipped };
}

// ============================================================
// Aggregation
// ============================================================

function aggregateConveniStats() {
  console.log("\n=== Aggregating conveni stats via SQL ===");

  // Backfill entity_id from slug
  console.log("  Backfilling entity_id...");
  runSQL(`
    UPDATE convenis c SET entity_id = e.id
    FROM entities e WHERE c.entity_slug = e.slug AND c.entity_id IS NULL;
  `);

  // Reset conveni fields
  console.log("  Resetting conveni fields...");
  runSQL(`
    UPDATE entities SET total_convenis = 0, total_conveni_amount = 0
    WHERE total_convenis > 0 OR total_conveni_amount > 0;
  `);

  // Aggregate conveni totals per entity
  // COUNT includes all convenis (with and without amount)
  // SUM only includes exact amounts (NULLs excluded automatically by SUM)
  console.log("  Updating entity conveni totals...");
  runSQL(`
    WITH conv_agg AS (
      SELECT entity_id,
        COUNT(*) AS total_convenis,
        SUM(amount_total) AS total_conveni_amount
      FROM convenis WHERE entity_id IS NOT NULL
      GROUP BY entity_id
    )
    UPDATE entities e SET
      total_convenis = ca.total_convenis,
      total_conveni_amount = COALESCE(ca.total_conveni_amount, 0),
      updated_at = NOW()
    FROM conv_agg ca WHERE e.id = ca.entity_id;
  `);

  // Recalculate total_public_funds (grants + contracts only — convenis excluded)
  console.log("  Recalculating total_public_funds (grants + contracts, NO convenis)...");
  runSQL(`
    UPDATE entities SET
      total_public_funds = COALESCE(total_amount, 0) + COALESCE(total_contract_amount, 0),
      updated_at = NOW()
    WHERE total_amount > 0 OR total_contract_amount > 0;
  `);

  // No materialised view in sql/matviews/ reads convenis: nothing to refresh.
  // total_public_funds above is provisional; aggregate-stats.ts recomputes it.

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

  console.log("=== Menjometre Convenis Data Sync (SQL mode) ===");
  console.log(`Source: SODA API (dataset exh2-diuf)`);
  console.log(`Mode: ${isDryRun ? "dry-run" : isFull ? "full" : "resume"}`);
  console.log(`Batch size: ${BATCH_SIZE} (API) / ${SQL_BATCH} (SQL insert)`);

  // Fetch first batch
  console.log("\nFetching first batch...");
  const firstBatch = await fetchSodaPage(0);
  console.log(`First batch: ${firstBatch.length} records`);

  if (isDryRun) {
    console.log("\n=== DRY RUN: Sample records ===");
    const sampleRows = processRecords(firstBatch.slice(0, 10));
    for (const row of sampleRows.slice(0, 10)) {
      console.log(`  ${row.signature_date ?? "NO-DATE"} | ${row.entity_slug.substring(0, 40)} | EUR${row.amount_total ?? "NULL"} | ${row.category ?? "NO-CAT"} | ${row.conveni_number ?? "NO-NUM"}`);
    }

    // Count total records
    const countUrl = `${SODA_BASE}?$select=count(*) as cnt`;
    const countResp = await fetch(countUrl);
    const countData = await countResp.json();
    console.log(`\nTotal records in dataset: ${Number(countData[0]?.cnt ?? 0).toLocaleString()}`);

    // Parse stats
    const allRows = processRecords(firstBatch);
    const withAmount = allRows.filter(r => r.amount_total !== null);
    const uniqueEntities = new Set(allRows.map(r => r.entity_slug));
    console.log(`Rows from first batch: ${allRows.length} (${withAmount.length} with exact amount)`);
    console.log(`Unique entities in first batch: ${uniqueEntities.size}`);

    console.log("Dry run complete. No data written.");
    return;
  }

  // Determine resume offset
  let startOffset = 0;
  if (!isFull) {
    const existing = runSQL("SELECT COUNT(*) FROM convenis;");
    const existingCount = parseInt(existing) || 0;
    if (existingCount > 0) {
      startOffset = Math.floor(existingCount / BATCH_SIZE) * BATCH_SIZE;
      console.log(`Resuming from offset ${startOffset} (${existingCount} existing convenis)`);
    }
  }

  const startTime = Date.now();

  try {
    let totalFetched = 0;
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalEntities = 0;
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

      // Process records: one row per non-Generalitat signatory
      const rows = processRecords(batch);
      console.log(`  Expanded to ${rows.length} conveni rows`);

      // Upsert entities via SQL
      const entityCount = upsertEntitiesSQL(rows);
      totalEntities += entityCount;
      console.log(`  Upserted ${entityCount} entities`);

      // Insert convenis via SQL
      const { processed, skipped } = insertConvenisSQL(rows);
      totalProcessed += processed;
      totalSkipped += skipped;
      console.log(`  Inserted ${processed} convenis (dedup skipped: ${skipped})`);

      offset += batch.length;
      await sleep(RATE_LIMIT_MS);

      if (batch.length < BATCH_SIZE) break;
    }

    // Aggregate
    if (!skipAggregation) {
      aggregateConveniStats();
    } else {
      console.log("\n=== Skipping aggregation (--skip-aggregation) ===");
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("\n=== Sync Summary ===");
    console.log(`Records fetched: ${totalFetched.toLocaleString()}`);
    console.log(`Rows processed: ${totalProcessed.toLocaleString()}`);
    console.log(`Rows skipped (dedup): ${totalSkipped.toLocaleString()}`);
    console.log(`Entities upserted: ${totalEntities.toLocaleString()}`);
    console.log(`Time: ${totalElapsed}s`);
    console.log("Status: COMPLETED");

    // Verify
    const finalCount = runSQL("SELECT COUNT(*) FROM convenis;");
    const withAmount = runSQL("SELECT COUNT(*) FROM convenis WHERE amount_total IS NOT NULL;");
    const totalAmount = runSQL("SELECT COALESCE(SUM(amount_total), 0)::NUMERIC FROM convenis WHERE amount_total IS NOT NULL;");
    console.log(`Convenis in DB: ${parseInt(finalCount).toLocaleString()}`);
    console.log(`With exact amount: ${parseInt(withAmount).toLocaleString()}`);
    console.log(`Total attributed EUR: ${parseFloat(totalAmount).toLocaleString()}`);
  } catch (err) {
    console.error("\n=== Sync FAILED ===", err);
    process.exit(1);
  }
}

main();
