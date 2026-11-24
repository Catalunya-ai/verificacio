/**
 * Menjometre Accountability Enrichment Script v3
 *
 * Hybrid model: obligated non-filers and voluntary filers are both scored.
 *
 * Fetches SODA datasets:
 *   1. Registre d'Entitats (y6fz-g3ff) — CIF→id_entitat, DUP/fundació classification
 *   2. Comptes Anuals (tjhe-8syr) — PGC financial data + filing existence via $group
 *   3. Compliment Ens Locals (7fnj-etev) — local gov compliance
 *
 * Entity groups:
 *   Group 1 (filing):        Obligated (DUP/fundació) + files at REJC
 *   Group 2 (no filing):     Obligated + does NOT file → scored
 *   Group 3 (voluntary):     Not obligated + files anyway → scored
 *   Group 4 (neutral):       No obligation, no filing → score_accountability = NULL
 *
 * Legal basis:
 *   - Art. 322-15 CCCat: DUP associations must deposit at REJC
 *   - Protectorat: Fundacions must deposit at REJC
 *   - Llei 19/2014 Art. 3.4: >100K triggers web publication (NOT REJC deposit)
 *   - F/Q/R/S entities file in other registries — excluded from scoring
 *
 * Usage:
 *   npx tsx src/connectors/enrich-accountability.ts --dry-run
 *   npx tsx src/connectors/enrich-accountability.ts --full
 *   npx tsx src/connectors/enrich-accountability.ts --limit=100
 *   (connection: DATABASE_URL, see src/lib/db.ts)
 */

import { createPsqlRunner } from "../lib/psql-runner";

const psql = createPsqlRunner({ processTimeoutMs: 600_000, maxBufferBytes: 200 * 1024 * 1024 });

function runSQL(sql: string): string {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  return psql.runSQL(oneLine).trim();
}

function escSql(val: string | null): string {
  if (val === null) return "NULL";
  // Strip null bytes (prevents escaping bypass), then escape single quotes
  const sanitized = val.replace(/\0/g, "");
  return `'${sanitized.replace(/'/g, "''")}'`;
}

function clampPct(val: number | null): number | null {
  if (val === null || isNaN(val)) return null;
  return Math.min(200, Math.max(0, Math.round(val * 100) / 100));
}

// ============================================================
// Constants
// ============================================================

const SODA_ANNUAL_ACCOUNTS = "https://analisi.transparenciacatalunya.cat/resource/tjhe-8syr.json";
const SODA_ENTITY_REGISTRY = "https://analisi.transparenciacatalunya.cat/resource/y6fz-g3ff.json";
const SODA_LOCAL_COMPLIANCE = "https://analisi.transparenciacatalunya.cat/resource/7fnj-etev.json";

const BATCH_SIZE = 50_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2_000;

// Income statement posicio codes (PGC fundacions) — used for financial data only
const POSICIO_REVENUE = "20500";
const POSICIO_OTHER_REVENUE = "25200";
// Grant income: prefer "Altres dades" posicions 5 + 6 (Ingressos per subvencions
// de la Generalitat + altres administracions), filed across all schemas.
// Fall back to PGC income statement 21700 (Subvencions imputats al resultat)
// only when 5/6 are absent.
const POSICIO_GRANT_INCOME_GENERALITAT = "5";
const POSICIO_GRANT_INCOME_OTHER = "6";
const POSICIO_GRANT_INCOME_PGC = "21700";
const POSICIO_PERSONNEL = "26200";

// Transparency signal weights (sum to ~1.0 excluding optional local_compliance)
const WEIGHT_FILES_ACCOUNTS = 0.35;
const WEIGHT_FILING_RECENCY = 0.20;
const WEIGHT_FILING_COVERAGE = 0.25;
const WEIGHT_REGISTRY = 0.15;
const WEIGHT_LOCAL_COMPLIANCE = 0.05;  // skipped when N/A, weight redistributed

// ============================================================
// SODA Fetch Helper
// ============================================================

async function fetchSodaAll<T>(
  endpoint: string,
  where?: string,
  select?: string,
  group?: string
): Promise<T[]> {
  const allRecords: T[] = [];
  let offset = 0;

  const headers: Record<string, string> = { Accept: "application/json" };
  const appToken = process.env.SODA_APP_TOKEN;
  if (appToken) headers["X-App-Token"] = appToken;

  while (true) {
    const params = new URLSearchParams();
    params.set("$limit", String(BATCH_SIZE));
    params.set("$offset", String(offset));
    if (group) {
      params.set("$group", group);
      params.set("$order", group); // order by group columns for stable pagination
    } else {
      params.set("$order", ":id");
    }
    if (where) params.set("$where", where);
    if (select) params.set("$select", select);

    const url = `${endpoint}?${params.toString()}`;
    let res: Response | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        res = await fetch(url, { headers });
        if (res.ok) break;
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`  SODA ${res.status}, retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new Error(`SODA API error: ${res.status} ${res.statusText}`);
      } catch (err) {
        if (attempt < MAX_RETRIES && (err as Error).message?.includes("fetch")) {
          await new Promise((r) => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }
    }

    if (!res || !res.ok) {
      throw new Error(`SODA API failed after ${MAX_RETRIES} retries`);
    }

    const data = (await res.json()) as T[];
    allRecords.push(...data);
    console.log(`  Fetched ${allRecords.length.toLocaleString()} records (offset ${offset.toLocaleString()})...`);

    if (data.length < BATCH_SIZE) break;
    offset += data.length;
  }

  return allRecords;
}

function slugify(name: string): string {
  return name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ============================================================
// Types
// ============================================================

interface AnnualAccountRecord {
  id_entitat?: string;
  nom_entitat?: string;
  exercici1?: string;
  posicio?: string;
  tipus_compte?: string;
  descripcio_comptes?: string;
  import?: string;
}

interface FilingExistenceRecord {
  id_entitat?: string;
  exercici1?: string;
}

interface RegistryRecord {
  id_entitat?: string;
  cif?: string;
  nom_entitat?: string;
  denominacio?: string;
  tipus_entitat?: string;
  classificacio_especifica?: string;
  data_inscripcio?: string;
}

interface LocalComplianceRecord {
  ens?: string;
  codi10?: string;
  compliment?: string;
}

interface MenjEntity {
  id: string;
  slug: string;
  name: string;
  cif: string | null;
  first_grant_year: number | null;
  last_grant_year: number | null;
  score_accountability: number | null;
  in_official_registry: boolean;
}

interface EntityAccountData {
  years: number[];
  revenue: Map<number, number>;
  // "Altres dades" pos 5 + 6 (subvencions Generalitat + altres admin), primary source
  grantIncomeAltresDades: Map<number, number>;
  // PGC pos 21700 (subvencions imputats al resultat), fallback only
  grantIncomePgc: Map<number, number>;
  personnelCost: Map<number, number>;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isFull = args.includes("--full");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 0;

  console.log("=== Menjometre Accountability Enrichment v3 (Hybrid Model) ===");
  console.log(`Mode: ${isDryRun ? "dry-run" : "live"}`);
  if (limit) console.log(`Limit: ${limit}`);

  // ── Step 1: Fetch Entity Registry + classify obligated entities ──
  console.log("\n1. Fetching entity registry (y6fz-g3ff)...");
  const registryRecords = await fetchSodaAll<RegistryRecord>(SODA_ENTITY_REGISTRY);
  console.log(`  Total registry entries: ${registryRecords.length.toLocaleString()}`);

  // Build CIF → id_entitat map (exclude "No consta" CIFs)
  const cifToIdEntitat = new Map<string, string>();
  for (const rec of registryRecords) {
    if (rec.id_entitat && rec.cif && rec.cif !== "No consta") {
      cifToIdEntitat.set(rec.cif.toUpperCase().trim(), rec.id_entitat);
    }
  }
  console.log(`  CIF→id_entitat mappings: ${cifToIdEntitat.size.toLocaleString()}`);

  // Build obligated CIF sets: DUP associations + fundacions
  const dupCifs = new Set<string>();
  const fundacioCifs = new Set<string>();
  for (const rec of registryRecords) {
    if (!rec.cif || rec.cif === "No consta") continue;
    const cif = rec.cif.toUpperCase().trim();
    if (rec.classificacio_especifica?.toUpperCase().includes("UTILITAT PÚBLICA")) {
      dupCifs.add(cif);
    }
    if (rec.tipus_entitat === "Fundació") {
      fundacioCifs.add(cif);
    }
  }
  const obligatedCifs = new Set<string>();
  dupCifs.forEach(c => obligatedCifs.add(c));
  fundacioCifs.forEach(c => obligatedCifs.add(c));
  console.log(`  DUP associations: ${dupCifs.size}`);
  console.log(`  Fundacions: ${fundacioCifs.size}`);
  console.log(`  Total obligated: ${obligatedCifs.size}`);

  // ── Step 2a: Fetch Annual Accounts — PGC financial data (filtered) ──
  console.log("\n2a. Fetching annual accounts — PGC financial data (tjhe-8syr)...");
  const accountRecords = await fetchSodaAll<AnnualAccountRecord>(
    SODA_ANNUAL_ACCOUNTS,
    `posicio in('${POSICIO_REVENUE}','${POSICIO_OTHER_REVENUE}','${POSICIO_GRANT_INCOME_GENERALITAT}','${POSICIO_GRANT_INCOME_OTHER}','${POSICIO_GRANT_INCOME_PGC}','${POSICIO_PERSONNEL}')`,
    "id_entitat,exercici1,posicio,import"
  );
  console.log(`  PGC financial records: ${accountRecords.length.toLocaleString()}`);

  // Group by id_entitat for financial data
  const accountsByEntity = new Map<string, EntityAccountData>();
  for (const rec of accountRecords) {
    if (!rec.id_entitat || !rec.exercici1) continue;

    let data = accountsByEntity.get(rec.id_entitat);
    if (!data) {
      data = {
        years: [],
        revenue: new Map(),
        grantIncomeAltresDades: new Map(),
        grantIncomePgc: new Map(),
        personnelCost: new Map(),
      };
      accountsByEntity.set(rec.id_entitat, data);
    }

    const year = parseInt(rec.exercici1, 10);
    if (isNaN(year)) continue;
    if (!data.years.includes(year)) data.years.push(year);

    const amount = Math.abs(parseFloat(rec.import ?? "0") || 0);
    if (rec.posicio === POSICIO_REVENUE || rec.posicio === POSICIO_OTHER_REVENUE) {
      data.revenue.set(year, (data.revenue.get(year) ?? 0) + amount);
    } else if (
      rec.posicio === POSICIO_GRANT_INCOME_GENERALITAT ||
      rec.posicio === POSICIO_GRANT_INCOME_OTHER
    ) {
      data.grantIncomeAltresDades.set(
        year,
        (data.grantIncomeAltresDades.get(year) ?? 0) + amount,
      );
    } else if (rec.posicio === POSICIO_GRANT_INCOME_PGC) {
      data.grantIncomePgc.set(year, (data.grantIncomePgc.get(year) ?? 0) + amount);
    } else if (rec.posicio === POSICIO_PERSONNEL) {
      data.personnelCost.set(year, (data.personnelCost.get(year) ?? 0) + amount);
    }
  }
  console.log(`  Entities with PGC financial data: ${accountsByEntity.size.toLocaleString()}`);

  // ── Step 2b: Fetch filing existence — ALL schemas via $group ──
  console.log("\n2b. Fetching filing existence (all schemas, $group dedup)...");
  const filingRecords = await fetchSodaAll<FilingExistenceRecord>(
    SODA_ANNUAL_ACCOUNTS,
    undefined,
    "id_entitat,exercici1",
    "id_entitat,exercici1"
  );
  console.log(`  Unique entity-year pairs: ${filingRecords.length.toLocaleString()}`);

  // Build Map<id_entitat, Set<year>>
  const filingsByEntity = new Map<string, Set<number>>();
  for (const rec of filingRecords) {
    if (!rec.id_entitat || !rec.exercici1) continue;
    const year = parseInt(rec.exercici1, 10);
    if (isNaN(year)) continue;
    let years = filingsByEntity.get(rec.id_entitat);
    if (!years) { years = new Set(); filingsByEntity.set(rec.id_entitat, years); }
    years.add(year);
  }
  console.log(`  Entities with ANY filing: ${filingsByEntity.size.toLocaleString()}`);

  // ── Step 3: Fetch Local Compliance (7fnj-etev) ──
  console.log("\n3. Fetching local compliance (7fnj-etev)...");
  const complianceRecords = await fetchSodaAll<LocalComplianceRecord>(SODA_LOCAL_COMPLIANCE);
  console.log(`  Compliance records: ${complianceRecords.length.toLocaleString()}`);

  const complianceBySlug = new Map<string, boolean>();
  for (const rec of complianceRecords) {
    if (!rec.ens || !rec.compliment) continue;
    const slug = slugify(rec.ens);
    complianceBySlug.set(slug, rec.compliment.toLowerCase().includes("compleix") && !rec.compliment.toLowerCase().includes("no compleix"));
  }
  console.log(`  Entities with compliance data: ${complianceBySlug.size.toLocaleString()}`);

  // ── Step 4: Load entities from DB ──
  console.log("\n4. Loading entities from DB...");
  const entities: MenjEntity[] = [];
  const entityRaw = runSQL(
    `SELECT id, slug, name, cif, first_grant_year, last_grant_year, score_accountability, in_official_registry FROM entities WHERE cif IS NOT NULL ORDER BY id`
  );
  if (entityRaw) {
    for (const line of entityRaw.split("\n")) {
      const [id, slug, name, cif, firstGrantYear, lastGrantYear, scoreAcc, inRegistry] = line.split("|");
      if (!id) continue;
      entities.push({
        id,
        slug,
        name,
        cif: cif || null,
        first_grant_year: firstGrantYear ? parseInt(firstGrantYear, 10) : null,
        last_grant_year: lastGrantYear ? parseInt(lastGrantYear, 10) : null,
        score_accountability: scoreAcc ? parseFloat(scoreAcc) : null,
        in_official_registry: inRegistry?.trim() === "t",
      });
    }
  }
  console.log(`  Loaded ${entities.length.toLocaleString()} entities (with CIF)`);

  const targetEntities = limit ? entities.slice(0, limit) : entities;

  // Build ID→entity map for O(1) lookups in diagnostics
  const entityById = new Map<string, MenjEntity>();
  for (const e of targetEntities) entityById.set(e.id, e);

  // ── Step 5: Calculate accountability for each entity ──
  console.log("\n5. Calculating accountability scores (hybrid model)...");

  interface FinancialYearlyRow {
    entity_id: string;
    year: number;
    revenue: number | null;
    grant_income: number | null;
    personnel_cost: number | null;
    grant_dependency_pct: number | null;
    personnel_cost_pct: number | null;
  }

  interface EntityUpdate {
    id: string;
    files_accounts: boolean;
    latest_account_year: number | null;
    in_official_registry: boolean;
    grant_dependency_pct: number | null;
    registry_id_entitat: string | null;
    account_years: number[];
    accountability_ratio: number | null;
    score_accountability: number | null;
    personnel_cost_pct: number | null;
    personnel_cost_source: string | null;
    personnel_cost_year: number | null;
    avg_grant_dependency_pct: number | null;
    avg_personnel_cost_pct: number | null;
    financial_years_count: number;
    accountability_source: string;
    accountability_updated_at: string;
    group: number; // 1-4 for diagnostics
  }

  const updates: EntityUpdate[] = [];
  const allFinancialRows: FinancialYearlyRow[] = [];
  const now = new Date().toISOString();
  const groupCounts = { g1: 0, g2: 0, g3: 0, g4: 0 };

  for (const entity of targetEntities) {
    const cif = entity.cif!.toUpperCase().trim();
    const idEntitat = cifToIdEntitat.get(cif);

    // Determine filing status (both PGC and simplified memòria)
    const hasFiling = idEntitat ? filingsByEntity.has(idEntitat) : false;
    const allFilingYears = idEntitat ? filingsByEntity.get(idEntitat) : undefined;
    const accountYears = allFilingYears ? Array.from(allFilingYears).sort((a, b) => a - b) : [];
    const latestAccountYear = accountYears.length > 0 ? accountYears[accountYears.length - 1] : null;

    // Classify entity into 4 groups
    // G-prefix = associations + fundacions (REJC scope)
    // Obligated entities are always scored even if non-G (a few DUP/fundacions have V/R prefix)
    const isGPrefix = cif.startsWith("G");
    const isObligated = obligatedCifs.has(cif);
    const isScored = isObligated || (isGPrefix && hasFiling);

    let group: number;
    if (!isGPrefix && !isObligated) {
      group = 4; // F/Q/R/S without obligation — file elsewhere
    } else if (isObligated && hasFiling) {
      group = 1; // Obligated and filing
    } else if (isObligated && !hasFiling) {
      group = 2; // Obligated, no filing — scored
    } else if (!isObligated && hasFiling) {
      group = 3; // Voluntary filer — scored
    } else {
      group = 4; // No obligation, no filing — neutral
    }

    if (group === 1) groupCounts.g1++;
    else if (group === 2) groupCounts.g2++;
    else if (group === 3) groupCounts.g3++;
    else groupCounts.g4++;

    // Registry status
    const inRegistry = cifToIdEntitat.has(cif) || entity.in_official_registry === true;

    // ── Compute financial data (PGC only — for display, not scoring) ──
    const accountData = idEntitat ? accountsByEntity.get(idEntitat) : undefined;
    const pgcYears = accountData ? accountData.years.sort((a, b) => a - b) : [];

    let grantDependencyPct: number | null = null;
    let personnelCostPct: number | null = null;
    let personnelCostYear: number | null = null;
    let avgGrantDependencyPct: number | null = null;
    let avgPersonnelCostPct: number | null = null;
    let financialYearsCount = 0;

    if (accountData && pgcYears.length > 0) {
      const depPcts: number[] = [];
      const perPcts: number[] = [];

      for (const yr of pgcYears) {
        const revenue = accountData.revenue.get(yr) ?? null;
        const altresDades = accountData.grantIncomeAltresDades.get(yr);
        const pgcGrant = accountData.grantIncomePgc.get(yr);
        // Prefer "Altres dades" pos 5+6 when the entity filed them (even as 0);
        // fall back to PGC pos 21700 only when pos 5+6 are fully absent.
        const grantIncome =
          altresDades !== undefined
            ? altresDades
            : pgcGrant !== undefined
              ? pgcGrant
              : null;
        const personnel = accountData.personnelCost.get(yr) ?? null;

        let yearDepPct: number | null = null;
        let yearPerPct: number | null = null;

        // Denominator = activity revenue only (pos 20500 / 25200). Earlier versions
        // added grantIncome again which double-counted income already booked under
        // "prestació de serveis" for contract/concertada entities.
        if (revenue != null && revenue > 0) {
          if (grantIncome !== null) {
            yearDepPct = clampPct(Math.round((grantIncome / revenue) * 100 * 100) / 100);
            depPcts.push(yearDepPct!);
          }
          if (personnel !== null) {
            yearPerPct = clampPct(Math.round((personnel / revenue) * 100 * 100) / 100);
            perPcts.push(yearPerPct!);
          }
        }

        allFinancialRows.push({
          entity_id: entity.id, year: yr,
          revenue, grant_income: grantIncome, personnel_cost: personnel,
          grant_dependency_pct: yearDepPct, personnel_cost_pct: yearPerPct,
        });
      }

      financialYearsCount = pgcYears.length;

      if (depPcts.length > 0) {
        avgGrantDependencyPct = Math.round((depPcts.reduce((a, b) => a + b, 0) / depPcts.length) * 100) / 100;
      }
      if (perPcts.length > 0) {
        avgPersonnelCostPct = Math.round((perPcts.reduce((a, b) => a + b, 0) / perPcts.length) * 100) / 100;
      }

      // Most recent year values (for display)
      for (let i = pgcYears.length - 1; i >= 0; i--) {
        const yr = pgcYears[i];
        const revenue = accountData.revenue.get(yr);
        const altresDades = accountData.grantIncomeAltresDades.get(yr);
        const pgcGrant = accountData.grantIncomePgc.get(yr);
        const grantIncome =
          altresDades !== undefined
            ? altresDades
            : pgcGrant !== undefined
              ? pgcGrant
              : undefined;
        const personnel = accountData.personnelCost.get(yr);
        if (revenue !== undefined && revenue > 0) {
          if (grantIncome !== undefined) {
            grantDependencyPct = clampPct(Math.round((grantIncome / revenue) * 100 * 100) / 100);
          }
          if (personnel !== undefined) {
            personnelCostPct = clampPct(Math.round((personnel / revenue) * 100 * 100) / 100);
            personnelCostYear = yr;
          }
          break;
        }
      }
    }

    // ── Compute transparency signals (Groups 1-3 only) ──
    let accountabilityRatio: number | null = null;
    let scoreAccountability: number | null = null;

    if (isScored) {
      // Signal 1: Files accounts (35%)
      const signalFilesAccounts = hasFiling ? 100 : 0;

      // Signal 2: Filing recency (20%)
      // Fallback: if grant years are NULL, use latest filing year as reference
      let signalRecentFiling = 0;
      const lastActivityYear = entity.last_grant_year ?? (latestAccountYear ? latestAccountYear : null);
      if (latestAccountYear && lastActivityYear) {
        const gap = lastActivityYear - latestAccountYear;
        if (gap <= 2) signalRecentFiling = 100;
        else if (gap <= 3) signalRecentFiling = 50;
      }

      // Signal 3: Filing coverage (25%)
      // Cap rangeStart to 2014 — REJC dataset begins ~2014, so earlier years are not scored
      // Fallback: if grant years NULL, use filing year range as reference
      const REJC_EARLIEST_YEAR = 2014;
      let signalFilingCoverage = 0;
      const coverageFirstYear = entity.first_grant_year ?? (accountYears.length > 0 ? accountYears[0] : null);
      const coverageLastYear = entity.last_grant_year ?? (accountYears.length > 0 ? accountYears[accountYears.length - 1] : null);
      if (accountYears.length > 0 && coverageFirstYear && coverageLastYear) {
        const rangeStart = Math.max(coverageFirstYear, REJC_EARLIEST_YEAR);
        const rangeEnd = coverageLastYear;
        const activeYears = rangeEnd - rangeStart + 1;
        if (activeYears > 0) {
          const relevant = accountYears.filter(y => y >= rangeStart && y <= rangeEnd).length;
          signalFilingCoverage = Math.min(100, Math.round((relevant / activeYears) * 100));
        }
      }

      // Signal 4: Official registry (15%)
      const signalRegistry = inRegistry ? 100 : 0;

      // Signal 5: Local compliance (5%, optional)
      let signalLocalCompliance: number | null = null;
      const compliance = complianceBySlug.get(entity.slug);
      if (compliance !== undefined) {
        signalLocalCompliance = compliance ? 100 : 0;
      }

      // Weighted sum
      let weightedSum = 0;
      let totalWeight = 0;

      weightedSum += signalFilesAccounts * WEIGHT_FILES_ACCOUNTS;
      totalWeight += WEIGHT_FILES_ACCOUNTS;

      weightedSum += signalRecentFiling * WEIGHT_FILING_RECENCY;
      totalWeight += WEIGHT_FILING_RECENCY;

      weightedSum += signalFilingCoverage * WEIGHT_FILING_COVERAGE;
      totalWeight += WEIGHT_FILING_COVERAGE;

      weightedSum += signalRegistry * WEIGHT_REGISTRY;
      totalWeight += WEIGHT_REGISTRY;

      if (signalLocalCompliance !== null) {
        weightedSum += signalLocalCompliance * WEIGHT_LOCAL_COMPLIANCE;
        totalWeight += WEIGHT_LOCAL_COMPLIANCE;
      }

      accountabilityRatio = totalWeight > 0
        ? Math.round((weightedSum / totalWeight) * 100) / 100
        : 0;
      // Invert: high accountabilityRatio = transparent (good) → low score_accountability
      // This keeps score_accountability consistent with other components where a higher value means a more marked pattern
      scoreAccountability = Math.round((100 - accountabilityRatio) * 100) / 100;
    }

    updates.push({
      id: entity.id,
      files_accounts: hasFiling,
      latest_account_year: latestAccountYear,
      in_official_registry: inRegistry,
      grant_dependency_pct: grantDependencyPct,
      registry_id_entitat: idEntitat ?? null,
      account_years: accountYears,
      accountability_ratio: accountabilityRatio,
      score_accountability: scoreAccountability,
      personnel_cost_pct: personnelCostPct,
      personnel_cost_source: personnelCostPct != null ? "soda_comptes_anuals" : null,
      personnel_cost_year: personnelCostYear,
      avg_grant_dependency_pct: avgGrantDependencyPct,
      avg_personnel_cost_pct: avgPersonnelCostPct,
      financial_years_count: financialYearsCount,
      accountability_source: "soda_enrichment",
      accountability_updated_at: now,
      group,
    });
  }

  console.log(`\n  Group 1 (obligated + files):     ${groupCounts.g1.toLocaleString()}`);
  console.log(`  Group 2 (obligated, no filing): ${groupCounts.g2.toLocaleString()}`);
  console.log(`  Group 3 (voluntary — not obligated, files):   ${groupCounts.g3.toLocaleString()}`);
  console.log(`  Group 4 (neutral — no score):                 ${groupCounts.g4.toLocaleString()}`);
  console.log(`  Total updates: ${updates.length.toLocaleString()}`);

  // ── Step 6: Dry-run diagnostics ──
  if (isDryRun) {
    console.log("\n=== DRY RUN DIAGNOSTICS ===");

    const scored = updates.filter(u => u.score_accountability !== null);
    const nulled = updates.filter(u => u.score_accountability === null);
    const hadScoreBefore = updates.filter(u => {
      const old = entityById.get(u.id);
      return old?.score_accountability !== null;
    });

    console.log(`\n  Scored (Groups 1-3): ${scored.length}`);
    console.log(`  Nulled (Group 4):    ${nulled.length}`);
    console.log(`  Had score before:    ${hadScoreBefore.length}`);
    console.log(`  Lost score (→NULL):  ${hadScoreBefore.filter(u => u.score_accountability === null).length}`);

    // Score distribution for scored entities
    if (scored.length > 0) {
      const buckets = { "0-20": 0, "20-40": 0, "40-60": 0, "60-80": 0, "80-100": 0 };
      for (const u of scored) {
        const s = u.score_accountability!;
        if (s < 20) buckets["0-20"]++;
        else if (s < 40) buckets["20-40"]++;
        else if (s < 60) buckets["40-60"]++;
        else if (s < 80) buckets["60-80"]++;
        else buckets["80-100"]++;
      }
      console.log(`\n  score_accountability distribution (Groups 1-3):`);
      for (const [k, v] of Object.entries(buckets)) {
        console.log(`    ${k}: ${v}`);
      }
    }

    // Top 10 obligated entities without filed accounts (Group 2)
    const nonCompliant = updates.filter(u => u.group === 2);
    if (nonCompliant.length > 0) {
      console.log(`\n  Obligated entities without filed accounts (Group 2):`);
      // Get names from targetEntities
      const ncWithNames = nonCompliant.map(u => {
        const e = entityById.get(u.id);
        return { ...u, name: e?.name ?? u.id, cif: e?.cif ?? "" };
      }).sort((a, b) => (b.score_accountability ?? 0) - (a.score_accountability ?? 0));
      for (const u of ncWithNames.slice(0, 10)) {
        console.log(`    ${u.cif} ${u.name.substring(0, 45)} score=${u.score_accountability}`);
      }
    }

    console.log("\nDry run complete — no DB changes made.");
    return;
  }

  // ── Step 7: Write to DB ──
  console.log("\n6. Writing entity updates to DB (direct SQL)...");
  let written = 0;
  const UPDATE_BATCH = 500;

  for (let i = 0; i < updates.length; i += UPDATE_BATCH) {
    const batch = updates.slice(i, i + UPDATE_BATCH);
    const values = batch.map((u) => {
      const accountYearsArr = `'{${u.account_years.join(",")}}'::int[]`;
      return `(${escSql(u.id)}::uuid, ${u.files_accounts}::bool, ${u.latest_account_year ?? "NULL"}::int, ${u.in_official_registry}::bool, ${clampPct(u.grant_dependency_pct) ?? "NULL"}::numeric, ${escSql(u.registry_id_entitat)}::text, ${accountYearsArr}, ${u.accountability_ratio ?? "NULL"}::numeric, ${u.score_accountability ?? "NULL"}::numeric, ${clampPct(u.personnel_cost_pct) ?? "NULL"}::numeric, ${escSql(u.personnel_cost_source)}::text, ${u.personnel_cost_year ?? "NULL"}::int, ${clampPct(u.avg_grant_dependency_pct) ?? "NULL"}::numeric, ${clampPct(u.avg_personnel_cost_pct) ?? "NULL"}::numeric, ${u.financial_years_count}::int, ${escSql(u.accountability_source)}::text, ${escSql(u.accountability_updated_at)}::timestamptz)`;
    }).join(",\n");

    runSQL(`
      UPDATE entities e SET
        files_accounts = v.files_accounts,
        latest_account_year = v.latest_account_year,
        in_official_registry = v.in_official_registry,
        grant_dependency_pct = v.grant_dependency_pct,
        registry_id_entitat = v.registry_id_entitat,
        account_years = v.account_years,
        accountability_ratio = v.accountability_ratio,
        score_accountability = v.score_accountability,
        personnel_cost_pct = COALESCE(v.personnel_cost_pct, e.personnel_cost_pct),
        personnel_cost_source = COALESCE(v.personnel_cost_source, e.personnel_cost_source),
        personnel_cost_year = COALESCE(v.personnel_cost_year, e.personnel_cost_year),
        avg_grant_dependency_pct = v.avg_grant_dependency_pct,
        avg_personnel_cost_pct = v.avg_personnel_cost_pct,
        financial_years_count = v.financial_years_count,
        accountability_source = v.accountability_source,
        accountability_updated_at = v.accountability_updated_at
      FROM (VALUES ${values}) AS v(
        id, files_accounts, latest_account_year, in_official_registry,
        grant_dependency_pct, registry_id_entitat, account_years,
        accountability_ratio, score_accountability,
        personnel_cost_pct, personnel_cost_source, personnel_cost_year,
        avg_grant_dependency_pct, avg_personnel_cost_pct,
        financial_years_count, accountability_source, accountability_updated_at
      )
      WHERE e.id = v.id
    `);

    written += batch.length;
    if (written % 5000 === 0 || i + UPDATE_BATCH >= updates.length) {
      console.log(`  Progress: ${written.toLocaleString()}/${updates.length.toLocaleString()}`);
    }
  }

  // ── Step 8: Upsert entity_financials_yearly rows (PGC data only) ──
  if (allFinancialRows.length > 0) {
    console.log(`\n7. Upserting ${allFinancialRows.length.toLocaleString()} financial yearly rows...`);
    let finWritten = 0;
    const FIN_BATCH = 500;

    for (let i = 0; i < allFinancialRows.length; i += FIN_BATCH) {
      const batch = allFinancialRows.slice(i, i + FIN_BATCH);
      const values = batch.map((r) =>
        `(${escSql(r.entity_id)}::uuid, ${r.year}, ${r.revenue ?? "NULL"}, ${r.grant_income ?? "NULL"}, ${r.personnel_cost ?? "NULL"}, ${clampPct(r.grant_dependency_pct) ?? "NULL"}, ${clampPct(r.personnel_cost_pct) ?? "NULL"})`
      ).join(",\n");

      runSQL(`
        INSERT INTO entity_financials_yearly (entity_id, year, revenue, grant_income, personnel_cost, grant_dependency_pct, personnel_cost_pct)
        VALUES ${values}
        ON CONFLICT (entity_id, year) DO UPDATE SET
          revenue = EXCLUDED.revenue,
          grant_income = EXCLUDED.grant_income,
          personnel_cost = EXCLUDED.personnel_cost,
          grant_dependency_pct = EXCLUDED.grant_dependency_pct,
          personnel_cost_pct = EXCLUDED.personnel_cost_pct
      `);

      finWritten += batch.length;
      if (finWritten % 10000 === 0 || i + FIN_BATCH >= allFinancialRows.length) {
        console.log(`  Progress: ${finWritten.toLocaleString()}/${allFinancialRows.length.toLocaleString()}`);
      }
    }
    console.log(`  Financial rows written: ${finWritten.toLocaleString()}`);
  }

  // ── Step 9: ANALYZE tables ──
  console.log("\n8. Running ANALYZE...");
  runSQL("ANALYZE entity_financials_yearly; ANALYZE entities;");

  console.log(`\n=== Accountability Enrichment Complete ===`);
  console.log(`Written: ${written.toLocaleString()}`);
  console.log(`  Scored (Groups 1-3): ${updates.filter(u => u.score_accountability !== null).length}`);
  console.log(`  Nulled (Group 4):    ${updates.filter(u => u.score_accountability === null).length}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
