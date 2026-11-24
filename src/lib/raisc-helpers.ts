/**
 * Shared helpers for RAISC data pipeline (SODA API).
 *
 * Contains entity/grant mapping, territorial lookup, and slugification
 * used by sync-raisc.ts (SODA API endpoint s9xt-n979).
 *
 * Database writes go straight to PostgreSQL (DATABASE_URL) with parameterised
 * multi-row INSERT ... ON CONFLICT statements.
 */

import type { Queryable } from "./db";
import { remapSlugsToExistingCifs } from "./entity-resolver";
import { slugifyGrants as slugify } from "./slugify";

// ============================================================
// Types
// ============================================================

export interface RaiscRow {
  clau: string;
  entitat_oo_aa_o_departament: string;
  entitat_oo_aa_o_departament_1: string;
  codi_raisc: string;
  codi_bdns: string;
  discriminador_de_la_concessi: string;
  any_de_la_convocat_ria: string;
  objecte_de_la_convocat_ria: string;
  t_tol_convocat_ria_catal: string;
  t_tol_convocat_ria_castell: string;
  bases_reguladores_url_catal: string;
  bases_reguladores_url_castell: string;
  subfinalitat_codi: string;
  subfinalitat: string;
  finalitat_rais_codi: string;
  finalitat_rais: string;
  finalitat_p_blica_codi: string;
  finalitat_p_blica: string;
  tipus_d_instument_d_ajut: string;
  tipus_d_instument_d_ajut_1: string;
  aplicaci_pressupost_ria: string;
  tipus_de_beneficiaris_codi: string;
  tipus_de_beneficiaris: string;
  cif_beneficiari: string;
  ra_social_del_beneficiari: string;
  codi_territorial: string;
  ajut_d_estat: string;
  ajut_d_estat_mecanisme_d_autoritzaci_codi: string;
  ajut_d_estat_mecanisme_d_autoritzaci_: string;
  ajut_d_estat_reglament_ue: string;
  ajut_d_estat_reglament_ue_1: string;
  ajut_d_estat_refer_ncia_ue: string;
  ajut_d_estat_objectius_del_1: string;
  data_concessi: string;
  import_subvenci_pr_stec_ajut: string;
  import_ajuda_equivalent: string;
  administraci_codi: string;
  administraci_: string;
  departament_o_entitat_local_d_adscripci_codi: string;
  departament_o_entitat_local_d_adscripci_: string;
}

export interface TerritorialMapping {
  codi_territorial: string;
  comarca_code: string;
  province_code: string;
  comarca_name: string;
  province_name: string;
}

export interface MappedEntity {
  slug: string;
  name: string;
  cif: string | null;
  comarca_code: string | null;
  province_code: string | null;
  comarca: string | null;
  beneficiary_type: string | null;
}

export interface MappedGrant {
  entity_slug: string;
  cif: string | null;
  amount: number;
  department: string;
  sub_purpose: string | null;
  purpose: string | null;
  grant_year: number | null;
  grant_date: string | null;
  bdns_code: string | null;
  convocatoria: string | null;
  source_dataset: string;
  ccaa_code: string;
  raisc_clau: string | null;
  raisc_code: string | null;
  beneficiary_type_code: string | null;
  instrument_type: string | null;
  finalitat_rais: string | null;
  finalitat_publica: string | null;
  administracio: string | null;
  regulatory_url_ca: string | null;
  regulatory_url_es: string | null;
  grant_description: string | null;
  budget_code: string | null;
  is_state_aid: boolean;
  state_aid_mechanism: string | null;
  eu_reference: string | null;
  is_credit: boolean;
}

// ============================================================
// CIF classification
// ============================================================

/**
 * Company CIF prefixes — letter-first identifiers belonging to organisations.
 * A-H: standard companies. J: civil associations. K: public organisms.
 * L: local public organisms. M: comunidades de bienes. N: foreign entities.
 * P: local corporations. Q: public organisms (alt). R: religious entities.
 * S: government organs. U: UTEs (joint ventures). V: others. W: permanent establishments.
 *
 *  * Note: do NOT use [A-H,J,...] regex — literal commas cause false matches.
 */
const COMPANY_CIF_PREFIXES = new Set("ABCDEFGHJKLMNPQRSUVW".split(""));

/**
 * Blocked CIFs — synthetic/placeholder identifiers that should never be stored.
 * Extended via: SELECT cif FROM entities WHERE cif ~ '^[A-Z]0{6,}' GROUP BY cif
 */
const BLOCKED_CIFS = new Set(["A00000000", "B00000000", "A0000000", "B0000000"]);

/** Returns true if the CIF belongs to a company (not a natural person) */
export function isCompanyCif(cif: string | null | undefined): boolean {
  if (!cif || cif.length < 2) return false;
  return COMPANY_CIF_PREFIXES.has(cif[0].toUpperCase());
}

// ============================================================
// Identifier classification (discriminated union)
// ============================================================

/**
 * Classified Spanish tax identifier.
 *
 * Only the 'cif' variant has a `normalized` field. This is intentional:
 * TypeScript prevents accidental storage of DNI/NIE at compile time since
 * `result.normalized` doesn't exist on non-CIF variants.
 */
export type ClassifiedIdentifier =
  | { type: "cif"; normalized: string; prefix: string; raw: string }
  | { type: "dni"; raw: string }        // 8 digits + letter — never store
  | { type: "nie"; raw: string }        // X/Y/Z + 7 digits + letter — never store
  | { type: "blocked"; raw: string }    // known placeholder/synthetic CIF
  | { type: "anonymized"; raw: string } // ***XXXX** pattern
  | { type: "unknown"; raw: string };   // no recognizable format

/**
 * Classify a raw identifier string from the RAISC beneficiary field.
 *
 * Priority order:
 * 1. Empty/null → unknown
 * 2. Contains asterisks → anonymized (partially redacted person)
 * 3. DNI (8 digits + letter) → dni — route to PERSONAS-FISICAS bucket
 * 4. NIE (X/Y/Z + 7 digits + letter) → nie — route to PERSONAS-FISICAS bucket
 * 5. Blocked/placeholder → blocked
 * 6. Company CIF prefix (A-HJKLMNP-SUVW) + valid structure → cif
 * 7. Otherwise → unknown (treat as org by name, no CIF)
 *
 * T-prefix (temporary foreign tax ID) → unknown → org-by-name (correct).
 * Sole proprietors (autónomos) use DNI as business ID → correctly bucketed.
 */
export function classifyIdentifier(raw: string | null | undefined): ClassifiedIdentifier {
  if (!raw || !raw.trim()) return { type: "unknown", raw: raw ?? "" };
  const s = raw.trim().toUpperCase();

  // Anonymized (partial asterisk redaction): e.g. "***8736**"
  if (/\*{2,}/.test(s)) return { type: "anonymized", raw: s };

  // DNI: exactly 8 digits + 1 uppercase letter
  if (/^\d{8}[A-Z]$/.test(s)) return { type: "dni", raw: s };

  // NIE: X, Y, or Z + 7 digits + 1 uppercase letter
  if (/^[XYZ]\d{7}[A-Z]$/.test(s)) return { type: "nie", raw: s };

  // Blocked/synthetic CIF
  if (BLOCKED_CIFS.has(s)) return { type: "blocked", raw: s };

  // Company CIF: valid prefix + 7 digits + check char (letter or digit), length 9-10
  if (
    s.length >= 9 &&
    s.length <= 10 &&
    COMPANY_CIF_PREFIXES.has(s[0]) &&
    /^\d{7}/.test(s.slice(1, 8))
  ) {
    return { type: "cif", normalized: s, prefix: s[0], raw: s };
  }

  return { type: "unknown", raw: s };
}

// ============================================================
// Slugify
// ============================================================

/**
 * Normalize entity name to a stable slug for deduplication.
 * Canonical implementation: src/lib/slugify.ts → slugifyGrants
 * (frozen grants-pipeline behavior — see that module's header).
 */
export { slugify };

// ============================================================
// Date parsing
// ============================================================

/**
 * Parse date from RAISC data.
 * Handles DD/MM/YYYY (CSV), YYYY-MM-DD (ISO), and YYYY-MM-DDT... (SODA floating timestamp).
 */
export function parseDate(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();

  // Handle DD/MM/YYYY format (CSV)
  const ddmmyyyy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, day, month, year] = ddmmyyyy;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  // Handle YYYY-MM-DD or YYYY-MM-DDT... (SODA floating timestamp)
  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return isoMatch[1];
  }

  return null;
}

export function parseAmount(raw: string): number {
  if (!raw || !raw.trim()) return 0;
  const num = parseFloat(raw.trim());
  return isNaN(num) ? 0 : num;
}

// ============================================================
// Row helpers
// ============================================================

// Known-safe FSA names — generic buckets used when RAISC aggregates beneficiaries
// without naming them individually. Any other FSA name may be a real person.
const SAFE_FSA_NAMES_UPPER = new Set([
  "PERSONA FÍSICA",
  "PERSONA FISICA",
  "ESTRANGER-ALTRES",
  "ALTRES",
]);

export function isNonPublishable(row: RaiscRow): boolean {
  if (
    row.cif_beneficiari === "Benef. no publicable" ||
    row.ra_social_del_beneficiari === "Benef. no publicable"
  ) {
    return true;
  }
  // FSA = família/persona física. Treat any FSA row whose name is not a known-safe
  // generic bucket as non-publishable, consistent with RAISC's own policy.
  if (row.tipus_de_beneficiaris_codi === "FSA") {
    const normalizedName = (row.ra_social_del_beneficiari || "")
      .toUpperCase()
      .trim();
    if (!SAFE_FSA_NAMES_UPPER.has(normalizedName)) {
      return true;
    }
  }
  return false;
}

export function getEntitySlug(row: RaiscRow): string {
  if (isNonPublishable(row)) {
    const dept = row.departament_o_entitat_local_d_adscripci_ || "DESCONEGUT";
    return slugify(`BENEF NO PUBLICABLE ${dept}`);
  }
  return slugify(row.ra_social_del_beneficiari);
}

export function getEntityName(row: RaiscRow): string {
  if (isNonPublishable(row)) {
    const dept = row.departament_o_entitat_local_d_adscripci_ || "Desconegut";
    return `Benef. no publicable (${dept})`;
  }
  return row.ra_social_del_beneficiari.trim();
}

export function getCif(row: RaiscRow): string | null {
  if (!row.cif_beneficiari || isNonPublishable(row)) return null;
  const cif = row.cif_beneficiari.trim();
  if (!cif || cif.length < 6) return null;
  return cif.toUpperCase();
}

// ============================================================
// Territorial mapping
// ============================================================

let territorialCache: Map<string, TerritorialMapping> | null = null;

export async function loadTerritorialMapping(
  db: Queryable
): Promise<Map<string, TerritorialMapping>> {
  if (territorialCache) return territorialCache;

  let rows: TerritorialMapping[];
  try {
    ({ rows } = await db.query<TerritorialMapping & Record<string, unknown>>(
      "SELECT codi_territorial, comarca_code, province_code, comarca_name, province_name FROM territorial_mapping"
    ));
  } catch (error) {
    console.warn("  Warning: Could not load territorial_mapping:", getErrorMessage(error));
    territorialCache = new Map();
    return territorialCache;
  }

  territorialCache = new Map<string, TerritorialMapping>();
  for (const row of rows) {
    territorialCache.set(row.codi_territorial, row);
  }

  console.log(`  Loaded ${territorialCache.size} territorial mappings`);
  return territorialCache;
}

export function parseTerritorial(codiTerritorial: string): {
  comarcaCode: string | null;
  provinceCode: string | null;
  comarcaName: string | null;
} {
  if (!codiTerritorial || !codiTerritorial.trim()) {
    return { comarcaCode: null, provinceCode: null, comarcaName: null };
  }

  const mapping = territorialCache?.get(codiTerritorial.trim());
  if (mapping) {
    return {
      comarcaCode: mapping.comarca_code,
      provinceCode: mapping.province_code,
      comarcaName: mapping.comarca_name,
    };
  }

  // Fallback: parse code directly (format "comarca_province")
  const parts = codiTerritorial.trim().split("_");
  if (parts.length === 2) {
    return {
      comarcaCode: parts[0],
      provinceCode: parts[1],
      comarcaName: null,
    };
  }

  return { comarcaCode: null, provinceCode: null, comarcaName: null };
}

// ============================================================
// Row mapping
// ============================================================

export function mapToGrant(row: RaiscRow, entitySlug: string): MappedGrant | null {
  const amount = parseAmount(row.import_subvenci_pr_stec_ajut);
  if (amount <= 0) return null;

  const grantDate = parseDate(row.data_concessi);
  const grantYear = grantDate
    ? parseInt(grantDate.substring(0, 4), 10) || null
    : row.any_de_la_convocat_ria
      ? parseInt(row.any_de_la_convocat_ria, 10) || null
      : null;

  // RAISC SODA covers 2016-present; reject junk years
  if (grantYear !== null && (grantYear < 2016 || grantYear > 2030)) return null;

  return {
    entity_slug: entitySlug,
    cif: getCif(row),
    amount,
    department:
      row.departament_o_entitat_local_d_adscripci_ ||
      row.entitat_oo_aa_o_departament_1 ||
      "Desconegut",
    sub_purpose: row.subfinalitat || null,
    purpose: row.finalitat_rais || null,
    grant_year: grantYear,
    grant_date: grantDate,
    bdns_code: row.codi_bdns || null,
    convocatoria: row.t_tol_convocat_ria_catal || null,
    source_dataset: "raisc_concessions",
    // RAISC is Catalonia's register: the community code is a constant, not derived.
    ccaa_code: "CAT",
    raisc_clau: row.clau || null,
    raisc_code: row.codi_raisc || null,
    beneficiary_type_code: row.tipus_de_beneficiaris_codi || null,
    instrument_type: row.tipus_d_instument_d_ajut || null,
    finalitat_rais: row.finalitat_rais || null,
    finalitat_publica: row.finalitat_p_blica || null,
    administracio: row.administraci_ || null,
    regulatory_url_ca: row.bases_reguladores_url_catal || null,
    regulatory_url_es: row.bases_reguladores_url_castell || null,
    grant_description: row.objecte_de_la_convocat_ria || null,
    budget_code: row.aplicaci_pressupost_ria || null,
    is_state_aid: row.ajut_d_estat === "Si" || row.ajut_d_estat === "SI" || row.ajut_d_estat === "Sí",
    state_aid_mechanism: row.ajut_d_estat_mecanisme_d_autoritzaci_ || null,
    eu_reference: row.ajut_d_estat_refer_ncia_ue || null,
    is_credit: row.finalitat_rais === "CRÈDIT OFICIAL I SUPORT FINANCER",
  };
}

export function mapToEntity(row: RaiscRow): MappedEntity {
  const slug = getEntitySlug(row);
  const name = getEntityName(row);
  const cif = getCif(row);
  const { comarcaCode, provinceCode, comarcaName } = parseTerritorial(
    row.codi_territorial
  );

  return {
    slug,
    name,
    cif,
    comarca_code: comarcaCode,
    province_code: provinceCode,
    comarca: comarcaName,
    beneficiary_type: row.tipus_de_beneficiaris_codi || null,
  };
}

// ============================================================
// Retry wrapper
// ============================================================

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function throwBatchError(operation: string, rowCount: number, error: unknown): never {
  throw new Error(`${operation} failed for batch of ${rowCount} rows: ${getErrorMessage(error)}`);
}

function isRecoverableEntityUpsertError(message: string): boolean {
  // Expected when the CIF match is valid but the incoming slug is already owned.
  if (message.includes("entities_slug_key")) return true;

  // Postgres duplicate-key text can omit the constraint name; keep the
  // per-row conflict path for these known uniqueness races.
  return message.includes("duplicate key");
}

/**
 * Network cuts that are worth retrying: "fetch failed" from an HTTP client and
 * the socket errors of the PostgreSQL driver. Anything else (a constraint, a
 * syntax error, permissions) fails on the first attempt.
 */
export function isTransientNetworkError(message: string): boolean {
  return /fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|Connection terminated/i.test(message);
}

// Network retries. A short cut of 5-10 s is normal during a multi-hour load;
// with 7 attempts and exponential growth up to a 30 s ceiling the loader
// survives 1+2+4+8+16+30 = 61 s of CONTINUOUS outage before giving up.
export const RETRY_ATTEMPTS_DEFAULT = 7;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

function retryAttempts(): number {
  const raw = Number.parseInt(process.env.RAISC_RETRY_ATTEMPTS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : RETRY_ATTEMPTS_DEFAULT;
}

function retryBaseDelayMs(): number {
  // Tests only: with the 1000 ms default, exhausting the retries takes a
  // minute, which a unit test suite cannot afford.
  const raw = Number.parseInt(process.env.RAISC_RETRY_BASE_DELAY_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : RETRY_BASE_DELAY_MS;
}

/** Wait before retry `attempt` (1-indexed): exponential with a ceiling. */
export function retryDelayMs(attempt: number, baseMs = RETRY_BASE_DELAY_MS): number {
  return Math.min(RETRY_MAX_DELAY_MS, baseMs * 2 ** (attempt - 1));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = retryAttempts(),
  label = "operation"
): Promise<T> {
  const baseMs = retryBaseDelayMs();
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only network cuts are retried. An SQL error (constraint, syntax,
      // permissions) must fail on the first attempt: retrying it only
      // multiplies the time until the same failure.
      if (attempt === retries || !isTransientNetworkError(msg)) {
        throw err;
      }
      const delay = retryDelayMs(attempt, baseMs);
      console.warn(`  Retry ${attempt}/${retries} for ${label} (${delay}ms): ${msg}`);
      await sleep(delay);
    }
  }
  throw new Error("unreachable");
}

// ============================================================
// Batch upsert logic
// ============================================================

/** `($1,$2,...),($n,...)` placeholders for a multi-row INSERT. */
function valuesPlaceholders(rowCount: number, columnCount: number): string {
  const groups: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const cells: string[] = [];
    for (let c = 0; c < columnCount; c++) cells.push(`$${r * columnCount + c + 1}`);
    groups.push(`(${cells.join(",")})`);
  }
  return groups.join(",");
}

const ENTITY_GEO_COLUMNS = ["comarca_code", "province_code", "comarca", "beneficiary_type"] as const;

/** Optional fields are written only when the source row has them; otherwise the stored value is kept. */
const KEEP_IF_ABSENT = ENTITY_GEO_COLUMNS.map(
  (c) => `${c} = COALESCE(EXCLUDED.${c}, entities.${c})`
).join(",\n      ");

function geoValues(e: MappedEntity): (string | null)[] {
  return [e.comarca_code || null, e.province_code || null, e.comarca || null, e.beneficiary_type || null];
}

/**
 * Runs one statement with network retries. Returns the SQL error (not thrown)
 * when the database rejected it, so the caller can choose a recovery path;
 * throws when the network retries are exhausted.
 */
async function queryOrSqlError(
  db: Queryable,
  sql: string,
  params: unknown[],
  label: string,
  operation: string,
  rowCount: number
): Promise<Error | null> {
  try {
    await withRetry(() => db.query(sql, params), undefined, label);
    return null;
  } catch (err: unknown) {
    if (isTransientNetworkError(getErrorMessage(err))) {
      throwBatchError(operation, rowCount, err);
    }
    return err instanceof Error ? err : new Error(getErrorMessage(err));
  }
}

export async function upsertEntitiesBatch(
  db: Queryable,
  entityMap: Map<string, MappedEntity>
) {
  const entities = Array.from(entityMap.values());

  const withCif = entities.filter((e) => e.cif);
  let withoutCif = entities.filter((e) => !e.cif);

  // ---- CIF ENTITIES FIRST (authoritative) ----

  // Deduplicate by CIF within batch: keep one per CIF
  const cifMap = new Map<string, MappedEntity>();
  const cifDupes: MappedEntity[] = [];
  for (const e of withCif) {
    if (!cifMap.has(e.cif!)) {
      cifMap.set(e.cif!, e);
    } else {
      cifDupes.push(e);
    }
  }

  const uniqueByCif = Array.from(cifMap.values());

  // Cross-batch CIF lookup: remap slugs to match existing DB entities
  const remapped = await remapSlugsToExistingCifs(uniqueByCif, db);
  if (remapped > 0) console.log(`  Remapped ${remapped} entities to existing CIF slugs`);

  // Upsert entities WITH CIF — CIF is the identity
  for (let i = 0; i < uniqueByCif.length; i += 500) {
    const chunk = uniqueByCif.slice(i, i + 500);
    const params = chunk.flatMap((e) => [e.slug, e.name, e.cif, "raisc", ...geoValues(e)]);
    const sqlError = await queryOrSqlError(
      db,
      `INSERT INTO entities (slug, name, cif, name_source, ${ENTITY_GEO_COLUMNS.join(", ")})
    VALUES ${valuesPlaceholders(chunk.length, 8)}
    ON CONFLICT (cif) DO UPDATE SET
      slug = EXCLUDED.slug,
      name = EXCLUDED.name,
      name_source = EXCLUDED.name_source,
      ${KEEP_IF_ABSENT}`,
      params,
      "entity-upsert-withCif",
      "Entity upsert with CIF",
      chunk.length
    );

    if (sqlError) {
      if (isRecoverableEntityUpsertError(sqlError.message)) {
        for (const e of chunk) {
          await withRetry(async () => {
            try {
              await db.query(
                `UPDATE entities SET
                  name = $1,
                  name_source = 'raisc',
                  comarca_code = COALESCE($2, comarca_code),
                  province_code = COALESCE($3, province_code),
                  comarca = COALESCE($4, comarca),
                  beneficiary_type = COALESCE($5, beneficiary_type)
                WHERE cif = $6`,
                [e.name, ...geoValues(e), e.cif]
              );
            } catch (updateErr: unknown) {
              if (isTransientNetworkError(getErrorMessage(updateErr))) throw updateErr;
              // Expected recovery: if the CIF update cannot run after a
              // uniqueness conflict, retry by slug before failing the row.
              try {
                await db.query(
                  `INSERT INTO entities (slug, name, cif, name_source, ${ENTITY_GEO_COLUMNS.join(", ")})
                  VALUES ${valuesPlaceholders(1, 8)}
                  ON CONFLICT (slug) DO UPDATE SET
                    name = EXCLUDED.name,
                    cif = EXCLUDED.cif,
                    name_source = EXCLUDED.name_source,
                    ${KEEP_IF_ABSENT}`,
                  [e.slug, e.name, e.cif, "raisc", ...geoValues(e)]
                );
              } catch (upsertErr: unknown) {
                if (isTransientNetworkError(getErrorMessage(upsertErr))) throw upsertErr;
                throwBatchError("Entity single-row slug fallback upsert", 1, upsertErr);
              }
            }
          }, undefined, "entity-upsert-single");
        }
      } else {
        throwBatchError("Entity upsert with CIF", chunk.length, sqlError);
      }
    }
  }

  if (cifDupes.length > 0) {
    console.log(`  Skipped ${cifDupes.length} CIF-duplicate entities within batch`);
  }

  // ---- NO-CIF ENTITIES SECOND (only create if slug not already claimed) ----

  // Filter out slugs that are already claimed by a CIF entity in this batch
  const cifSlugs = new Set(uniqueByCif.map((e) => e.slug));
  const beforeFilter = withoutCif.length;
  withoutCif = withoutCif.filter((e) => !cifSlugs.has(e.slug));
  const droppedByCifClaim = beforeFilter - withoutCif.length;
  if (droppedByCifClaim > 0) {
    console.log(`  Skipped ${droppedByCifClaim} no-CIF entities (slug claimed by CIF entity)`);
  }

  // ON CONFLICT (slug) DO NOTHING — if the slug already exists in the DB (from
  // a CIF entity or a previous batch), do NOT overwrite. CIF data is authoritative.
  for (let i = 0; i < withoutCif.length; i += 500) {
    const chunk = withoutCif.slice(i, i + 500);
    const params = chunk.flatMap((e) => [
      e.slug,
      e.name,
      e.slug.startsWith("BENEF-NO-PUBLICABLE") && !isCompanyCif(e.cif),
      ...geoValues(e),
    ]);
    const sqlError = await queryOrSqlError(
      db,
      `INSERT INTO entities (slug, name, is_anonymized, ${ENTITY_GEO_COLUMNS.join(", ")})
    VALUES ${valuesPlaceholders(chunk.length, 7)}
    ON CONFLICT (slug) DO NOTHING`,
      params,
      "entity-upsert-noCif",
      "Entity upsert without CIF",
      chunk.length
    );

    if (sqlError) {
      // Expected slug duplicates are handled by DO NOTHING; any other error is
      // outside that idempotency contract and must stop the sync.
      throwBatchError("Entity upsert without CIF", chunk.length, sqlError);
    }
  }

  return entities.length;
}

/** Grant columns written by the loader, in INSERT order. */
const GRANT_COLUMNS = [
  "entity_id", "entity_slug", "cif", "amount", "department", "sub_purpose", "purpose",
  "grant_year", "grant_date", "bdns_code", "convocatoria", "source_dataset", "ccaa_code",
  "raisc_clau", "raisc_code", "beneficiary_type_code", "instrument_type", "finalitat_rais",
  "finalitat_publica", "administracio", "regulatory_url_ca", "regulatory_url_es",
  "grant_description", "budget_code", "is_state_aid", "state_aid_mechanism", "eu_reference",
  "is_credit",
] as const;

export async function insertGrantsBatch(
  db: Queryable,
  grants: MappedGrant[]
) {
  // Resolve entity_id: CIF-first, slug fallback
  const cifSet = new Set(grants.map((g) => g.cif).filter(Boolean) as string[]);
  const slugsWithoutCif = new Set(grants.filter((g) => !g.cif).map((g) => g.entity_slug));

  const cifToEntity = new Map<string, { id: string; slug: string }>();
  const slugToId = new Map<string, string>();

  // CIF lookup
  const cifs = Array.from(cifSet);
  for (let i = 0; i < cifs.length; i += 200) {
    const chunk = cifs.slice(i, i + 200);
    await withRetry(async () => {
      const { rows } = await db.query<{ id: string; slug: string; cif: string | null }>(
        "SELECT id, slug, cif FROM entities WHERE cif = ANY($1::text[])",
        [chunk]
      );
      for (const e of rows) {
        if (e.cif) cifToEntity.set(e.cif, { id: e.id, slug: e.slug });
      }
    }, undefined, "entity-lookup-cif");
  }

  // Slug fallback lookup (only for grants without CIF)
  const slugs = Array.from(slugsWithoutCif);
  for (let i = 0; i < slugs.length; i += 200) {
    const chunk = slugs.slice(i, i + 200);
    await withRetry(async () => {
      const { rows } = await db.query<{ id: string; slug: string }>(
        "SELECT id, slug FROM entities WHERE slug = ANY($1::text[])",
        [chunk]
      );
      for (const e of rows) {
        slugToId.set(e.slug, e.id);
      }
    }, undefined, "entity-lookup-slug");
  }

  const enriched = grants.map((g) => {
    const byCif = g.cif ? cifToEntity.get(g.cif) : null;
    return {
      ...g,
      entity_id: byCif?.id || slugToId.get(g.entity_slug) || null,
      entity_slug: byCif?.slug || g.entity_slug, // Use canonical slug
    };
  });

  let processed = 0;
  let skipped = 0;

  for (let i = 0; i < enriched.length; i += 1000) {
    const chunk = enriched.slice(i, i + 1000);
    const params = chunk.flatMap((g) => GRANT_COLUMNS.map((c) => (g as Record<string, unknown>)[c] ?? null));

    // ON CONFLICT (raisc_clau) DO NOTHING: a re-run never duplicates a grant.
    const sqlError = await queryOrSqlError(
      db,
      `INSERT INTO grants (${GRANT_COLUMNS.join(", ")})
    VALUES ${valuesPlaceholders(chunk.length, GRANT_COLUMNS.length)}
    ON CONFLICT (raisc_clau) DO NOTHING`,
      params,
      "grant-upsert",
      "Grant upsert",
      chunk.length
    );

    if (sqlError) {
      // Expected raisc_clau duplicates are handled by DO NOTHING; an error here
      // means the batch did not follow the idempotent path.
      throwBatchError("Grant upsert", chunk.length, sqlError);
    }

    processed += chunk.length;
  }

  return { processed, skipped };
}
