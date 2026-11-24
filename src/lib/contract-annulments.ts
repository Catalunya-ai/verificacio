/**
 * Official annulment lines of the open-data contracts source (dataset ybgg-dgi6, phase "Anul·lació").
 *
 * Pure parts and thin I/O helpers of the annulment load script, kept apart so they can be
 * unit-tested without a network or a database:
 *   - page URL, retries with backoff and a page cache;
 *   - normalisation of a source row into a stable line (amounts that are not a plain number, such
 *     as a list of suppliers separated by pipes, become null);
 *   - the INSERT that stores the lines and the targeted entity recompute;
 *   - the source check of rule 4: is there a non-annulment record of the same award?
 *
 * The decisions themselves are taken in SQL (public.contract_annulment_classify and
 * public.decide_contract_annulments), against the contracts of the database.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMaskedCif, parseCif } from "./contractes-helpers";
import { isDummyCif } from "./privacy";
import { slugifyContracts } from "./slugify";

// ============================================================
// Result classification
// ============================================================

/** An award that never happened: the line's resultat says so. An empty resultat is a retracted notice. */
export const NOT_AWARDED_RESULTATS: readonly string[] = ["Desistiment", "Renúncia", "Desert"];

export function isNotAwardedResultat(resultat: string | null | undefined): boolean {
  return typeof resultat === "string" && NOT_AWARDED_RESULTATS.includes(resultat.trim());
}

// ============================================================
// Source rows and lines
// ============================================================

export const SODA_RESOURCE = "https://analisi.transparenciacatalunya.cat/resource/ybgg-dgi6.json";
export const ANNULMENT_PAGE_SIZE = 1000;
const ANNULMENT_PHASE = "Anul·lació";

export interface SodaAnnulmentRow {
  codi_expedient?: string;
  nom_organ?: string;
  identificacio_adjudicatari?: string;
  denominacio_adjudicatari?: string;
  import_adjudicacio_sense?: string;
  data_adjudicacio_contracte?: string;
  enllac_publicacio?: { url?: string };
  es_agregada?: string;
  resultat?: string;
  data_publicacio_anul?: string;
}

export interface AnnulmentLine {
  lineKey: string;
  url: string;
  codiExpedient: string;
  organ: string;
  adjudicatariId: string;
  adjudicatari: string;
  /** null when the source amount is not a plain number. */
  amount: number | null;
  amountRaw: string;
  awardDate: string | null;
  resultat: string;
  agregada: string;
  annulDate: string | null;
}

/** A plain decimal number ("885", "211.2"); anything else (pipes, separators, text) is null. */
export function parsePlainAmount(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

/** The calendar date (YYYY-MM-DD) of a source timestamp, or null when it is absent or not a real date. */
export function isoDate(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2100) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

const text = (value: string | null | undefined): string => (typeof value === "string" ? value.trim() : "");

/** Normalises a source row into a line; null when it has no publication url or no expedient code. */
export function normalizeAnnulmentLine(raw: SodaAnnulmentRow): AnnulmentLine | null {
  const url = text(raw.enllac_publicacio?.url);
  const codiExpedient = text(raw.codi_expedient);
  if (!url || !codiExpedient) return null;

  const organ = text(raw.nom_organ);
  const adjudicatariId = text(raw.identificacio_adjudicatari);
  const adjudicatari = text(raw.denominacio_adjudicatari);
  const amountRaw = text(raw.import_adjudicacio_sense);
  const awardDate = isoDate(raw.data_adjudicacio_contracte);
  const resultat = text(raw.resultat);
  const agregada = text(raw.es_agregada);
  const annulDate = isoDate(raw.data_publicacio_anul);

  const lineKey = createHash("md5")
    .update([url, codiExpedient, organ, adjudicatariId, adjudicatari, amountRaw, awardDate ?? "", resultat, agregada, annulDate ?? ""].join("\u001f"))
    .digest("hex");

  return {
    lineKey,
    url,
    codiExpedient,
    organ,
    adjudicatariId,
    adjudicatari,
    amount: parsePlainAmount(amountRaw),
    amountRaw,
    awardDate,
    resultat,
    agregada,
    annulDate,
  };
}

// ============================================================
// HTTP: retries with backoff, page cache
// ============================================================

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  statusText?: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (url: string) => Promise<FetchResponseLike>;

export interface HttpDeps {
  fetchFn: FetchLike;
  sleep: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface PageCache {
  read(key: string): unknown[] | null;
  write(key: string, rows: unknown[]): void;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BASE_DELAY_MS = 2000;

/**
 * GET a JSON document. A 429, a 5xx or a network drop is retried with a doubling wait (a
 * Retry-After header longer than that wait wins); any other 4xx stops at once.
 */
export async function fetchJsonWithRetry(url: string, deps: HttpDeps, options: RetryOptions = {}): Promise<unknown> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastReason = "no attempt";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retryAfterMs = 0;
    try {
      const response = await deps.fetchFn(url);
      if (response.ok) return await response.json();
      if (response.status !== 429 && response.status < 500) {
        throw new Stop(`HTTP ${response.status} ${response.statusText ?? ""}`.trim());
      }
      lastReason = `HTTP ${response.status}`;
      const header = Number(response.headers.get("retry-after"));
      if (Number.isFinite(header) && header > 0) retryAfterMs = header * 1000;
    } catch (cause) {
      if (cause instanceof Stop) throw new Error(`Source request stopped: ${cause.message}`);
      lastReason = `network: ${(cause as Error).message}`;
    }
    if (attempt === maxAttempts) break;
    const delay = Math.max(baseDelayMs * 2 ** (attempt - 1), retryAfterMs);
    options.onRetry?.(attempt, delay, lastReason);
    await deps.sleep(delay);
  }
  throw new Error(`Source request gave up after ${maxAttempts} attempts (last: ${lastReason})`);
}

/** Marks a response that retrying cannot improve. */
class Stop {
  constructor(public readonly message: string) {}
}

export function annulmentPageUrl(offset: number, pageSize: number = ANNULMENT_PAGE_SIZE): string {
  const params = new URLSearchParams({
    $select: [
      "codi_expedient",
      "nom_organ",
      "identificacio_adjudicatari",
      "denominacio_adjudicatari",
      "import_adjudicacio_sense",
      "data_adjudicacio_contracte",
      "enllac_publicacio",
      "es_agregada",
      "resultat",
      "data_publicacio_anul",
      ":id",
    ].join(","),
    $where: `fase_publicacio = '${ANNULMENT_PHASE}' AND (import_adjudicacio_sense is not null OR import_adjudicacio_amb_iva is not null)`,
    // The row id settles ties, so that paging never skips or repeats a row.
    $order: "codi_expedient,data_publicacio_anul,enllac_publicacio,:id",
    $limit: String(pageSize),
    $offset: String(offset),
  });
  return `${SODA_RESOURCE}?${params}`;
}

export interface AnnulmentFetchOptions extends RetryOptions {
  pageSize?: number;
}

export interface AnnulmentFetchResult {
  lines: AnnulmentLine[];
  pages: number;
  fromCache: number;
  retries: number;
  /** Rows without publication url or expedient code. */
  skipped: number;
  /** Lines identical to one already read. */
  repeatedLines: number;
}

/** Reads every annulment line, page by page, one request at a time. */
export async function fetchAnnulmentLines(
  deps: HttpDeps & { cache?: PageCache },
  options: AnnulmentFetchOptions = {}
): Promise<AnnulmentFetchResult> {
  const pageSize = options.pageSize ?? ANNULMENT_PAGE_SIZE;
  const seen = new Map<string, AnnulmentLine>();
  const result: AnnulmentFetchResult = { lines: [], pages: 0, fromCache: 0, retries: 0, skipped: 0, repeatedLines: 0 };

  for (let offset = 0; ; offset += pageSize) {
    const key = `annulments:${pageSize}:${offset}`;
    let rows = deps.cache?.read(key) ?? null;
    if (rows) {
      result.fromCache++;
    } else {
      const url = annulmentPageUrl(offset, pageSize);
      rows = (await fetchJsonWithRetry(url, deps, {
        maxAttempts: options.maxAttempts,
        baseDelayMs: options.baseDelayMs,
        onRetry: (attempt, delayMs, reason) => {
          result.retries++;
          deps.log?.(`  page at offset ${offset}: ${reason}, waiting ${delayMs} ms (attempt ${attempt})`);
          options.onRetry?.(attempt, delayMs, reason);
        },
      })) as unknown[];
      if (!Array.isArray(rows)) throw new Error(`Unexpected source answer at offset ${offset}`);
      deps.cache?.write(key, rows);
    }
    result.pages++;

    for (const raw of rows as SodaAnnulmentRow[]) {
      const line = normalizeAnnulmentLine(raw);
      if (!line) {
        result.skipped++;
      } else if (seen.has(line.lineKey)) {
        result.repeatedLines++;
      } else {
        seen.set(line.lineKey, line);
      }
    }
    if (rows.length < pageSize) break;
  }

  result.lines = [...seen.values()];
  return result;
}

/** A cache of pages as JSON files in `dir`, reused while younger than `maxAgeMs`. */
export function createFileCache(dir: string, maxAgeMs: number, now: () => number = Date.now): PageCache {
  const fileOf = (key: string): string => join(dir, `page_${createHash("sha1").update(key).digest("hex").slice(0, 16)}.json`);
  return {
    read(key) {
      const file = fileOf(key);
      if (!existsSync(file)) return null;
      try {
        const body = JSON.parse(readFileSync(file, "utf8")) as { fetchedAt: number; rows: unknown[] };
        if (!Array.isArray(body.rows) || now() - body.fetchedAt > maxAgeMs) return null;
        return body.rows;
      } catch {
        return null;
      }
    },
    write(key, rows) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(fileOf(key), JSON.stringify({ fetchedAt: now(), rows }));
    },
  };
}

// ============================================================
// SQL builders
// ============================================================

function dollarTag(payload: string): string {
  for (;;) {
    const tag = `ann_${randomBytes(4).toString("hex")}`;
    if (!payload.includes(`$${tag}$`)) return `$${tag}$`;
  }
}

/** A string literal in dollar quotes, with a tag that does not occur in the text: no escaping needed. */
export function dollarQuoted(payload: string): string {
  const tag = dollarTag(payload);
  return `${tag}${payload}${tag}`;
}

/** One INSERT per chunk of lines; a line already known (same key) is left as it is. */
export function buildLinesUpsertSql(lines: AnnulmentLine[], chunkSize = 1000): string[] {
  const statements: string[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const payload = JSON.stringify(
      lines.slice(i, i + chunkSize).map((l) => ({
        line_key: l.lineKey,
        url: l.url,
        codi_expedient: l.codiExpedient,
        organ: l.organ,
        adjudicatari_id: l.adjudicatariId,
        adjudicatari: l.adjudicatari,
        amount: l.amount,
        award_date: l.awardDate,
        resultat: l.resultat,
        agregada: l.agregada,
        annul_date: l.annulDate,
      }))
    );
    const tag = dollarTag(payload);
    statements.push(`INSERT INTO public.contract_official_annulments
  (line_key, url, codi_expedient, organ, adjudicatari_id, adjudicatari, amount, award_date, resultat, agregada, annul_date)
SELECT x.line_key, x.url, x.codi_expedient, x.organ, x.adjudicatari_id, x.adjudicatari, x.amount, x.award_date, x.resultat, x.agregada, x.annul_date
  FROM jsonb_to_recordset(${tag}${payload}${tag}::jsonb)
       AS x(line_key text, url text, codi_expedient text, organ text, adjudicatari_id text, adjudicatari text,
            amount numeric, award_date date, resultat text, agregada text, annul_date date)
ON CONFLICT (line_key) DO NOTHING;`);
  }
  return statements;
}

/**
 * Steps 4, 5 and 6 of src/pipeline/aggregate-stats.ts (contract totals, total public funds, yearly
 * contract stats), restricted to the entities in `idsExpr`, an SQL expression that yields uuid[].
 * Set-based; nothing is deleted.
 */
export function entityRecomputeSql(idsExpr: string): string {
  return `
UPDATE public.entities SET total_contracts = 0, total_contract_amount = 0
 WHERE id = ANY(${idsExpr}) AND (total_contracts > 0 OR total_contract_amount > 0);

WITH contract_agg AS (
  SELECT entity_id,
    SUM(amount) AS total_contract_amount,
    COUNT(*) AS total_contracts
  FROM public.contracts
  WHERE superseded IS NOT TRUE AND entity_id IS NOT NULL AND entity_id = ANY(${idsExpr})
  GROUP BY entity_id
)
UPDATE public.entities e SET
  total_contracts = ca.total_contracts,
  total_contract_amount = ca.total_contract_amount,
  updated_at = NOW()
FROM contract_agg ca WHERE e.id = ca.entity_id;

UPDATE public.entities SET
  total_public_funds = COALESCE(total_amount, 0) + COALESCE(total_contract_amount, 0) + COALESCE(total_budget_transfers, 0) + COALESCE(total_accio_concertada, 0) + COALESCE(total_equity_contributions, 0),
  updated_at = NOW()
WHERE id = ANY(${idsExpr})
  AND (total_amount > 0 OR total_contract_amount > 0 OR total_budget_transfers > 0 OR total_accio_concertada > 0 OR total_equity_contributions > 0);

UPDATE public.entities SET total_public_funds = 0
WHERE id = ANY(${idsExpr})
  AND total_public_funds != 0 AND total_amount = 0 AND total_contract_amount = 0 AND total_budget_transfers = 0 AND total_accio_concertada = 0 AND total_equity_contributions = 0;

WITH yearly_contracts AS (
  SELECT c.entity_id, c.contract_year AS year,
    SUM(c.amount) AS amount, COUNT(*) AS cnt
  FROM public.contracts c
  WHERE c.superseded IS NOT TRUE AND c.contract_year IS NOT NULL AND c.entity_id IS NOT NULL
    AND c.entity_id = ANY(${idsExpr})
  GROUP BY c.entity_id, c.contract_year
)
UPDATE public.entity_yearly_stats eys SET
  contract_count = yc.cnt,
  contract_amount = yc.amount
FROM yearly_contracts yc
WHERE eys.entity_id = yc.entity_id AND eys.year = yc.year;

UPDATE public.entity_yearly_stats eys
SET contract_amount = 0, contract_count = 0
WHERE eys.entity_id = ANY(${idsExpr})
  AND eys.contract_amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.contracts c
    WHERE c.entity_id = eys.entity_id AND c.contract_year = eys.year
      AND c.superseded IS NOT TRUE
  );
`;
}

// ============================================================
// Rule 4: is there a non-annulment record of the same award?
// ============================================================

/** A contract that is the only copy of an annulled award, as read from contract_annulment_classify(). */
export interface OfficialCheckCandidate {
  organ: string;
  codiExpedient: string;
  keyCif: string;
  keySlug: string;
  lotNumber: string;
  lineUrl: string;
  adjudicatariId: string | null;
  adjudicatari: string | null;
  amount: number | null;
  awardDate: string | null;
}

/** A source record that is not an annulment. */
export interface SodaValidRecord {
  id: string;
  organ: string;
  codiExpedient: string;
  adjudicatariId: string;
  adjudicatari: string;
  amount: number | null;
  awardDate: string | null;
  fase: string;
  resultat: string;
}

/** The answer for one candidate, in the shape decide_contract_annulment_checks() reads. */
export interface OfficialCheckResult {
  organ: string;
  codi_expedient: string;
  cif: string;
  entity_slug: string;
  lot_number: string;
  /** The annulment publication the contract was derived from. */
  line_url: string;
  found: boolean;
  record_id?: string;
  /** Not sent to the database: a record with the same organ, supplier and amount but another award date. */
  near_miss?: boolean;
}

const AMOUNT_TOLERANCE = 0.005;

function idIsUsable(id: string | null | undefined): boolean {
  return sourceIdentifier(id) !== null;
}

function sourceIdentifier(id: string | null | undefined): string | null {
  const parsed = parseCif(id ?? undefined);
  if (parsed) return parsed;
  const trimmed = id?.trim().toUpperCase() ?? "";
  if (!trimmed || isMaskedCif(trimmed) || isDummyCif(trimmed)) return null;
  if (/^\d{8}[A-Z]$/.test(trimmed)) return trimmed;
  if (/^[XYZ]\d{7}[A-Z]$/.test(trimmed)) return trimmed;
  if (/^[A-Z]\d{7}[A-Z0-9]$/.test(trimmed)) return trimmed;
  if (/^[A-Z]{2}\d{5,}$/.test(trimmed)) return trimmed;
  return null;
}

const nameKey = (name: string | null | undefined): string => (name ? slugifyContracts(name) : "");

/** A candidate can be checked when the award is fully identified: amount, date, and an id or a name. */
export function isCheckable(c: OfficialCheckCandidate): boolean {
  return c.amount !== null && c.awardDate !== null && (idIsUsable(c.adjudicatariId) || nameKey(c.adjudicatari) !== "");
}

function matchRecord(candidate: OfficialCheckCandidate, records: SodaValidRecord[], requireDate: boolean): SodaValidRecord | null {
  if (!isCheckable(candidate)) return null;
  const candidateId = sourceIdentifier(candidate.adjudicatariId);

  for (const record of records) {
    if (record.fase.trim().toLowerCase().startsWith("anul")) continue;
    if (isNotAwardedResultat(record.resultat)) continue;
    if (record.organ.trim() !== candidate.organ.trim()) continue;
    if (record.amount === null || Math.abs(record.amount - (candidate.amount as number)) >= AMOUNT_TOLERANCE) continue;
    if (requireDate && (record.awardDate === null || record.awardDate !== candidate.awardDate)) continue;

    const recordId = sourceIdentifier(record.adjudicatariId);
    if (candidateId !== null && recordId !== null) {
      if (candidateId !== recordId) continue;
    } else {
      const wanted = nameKey(candidate.adjudicatari);
      if (wanted === "" || wanted !== nameKey(record.adjudicatari)) continue;
    }
    return record;
  }
  return null;
}

/**
 * The first record that is not an annulment, is not itself a withdrawn or empty award, and has the
 * candidate's organ, supplier, amount and award date. Supplier: the identifiers when both are
 * usable, otherwise the names. Any expedient code counts, the candidate's own included.
 */
export function matchValidRecord(candidate: OfficialCheckCandidate, records: SodaValidRecord[]): SodaValidRecord | null {
  return matchRecord(candidate, records, true);
}

/** Same as matchValidRecord but ignoring the award date: tells a candidate with no record at all from one whose date differs. */
export function matchNearMiss(candidate: OfficialCheckCandidate, records: SodaValidRecord[]): SodaValidRecord | null {
  return matchRecord(candidate, records, false);
}

export function toSodaValidRecord(raw: Record<string, unknown>): SodaValidRecord {
  const field = (name: string): string => (typeof raw[name] === "string" ? (raw[name] as string).trim() : "");
  return {
    id: field(":id"),
    organ: field("nom_organ"),
    codiExpedient: field("codi_expedient"),
    adjudicatariId: field("identificacio_adjudicatari"),
    adjudicatari: field("denominacio_adjudicatari"),
    amount: parsePlainAmount(field("import_adjudicacio_sense")),
    awardDate: isoDate(field("data_adjudicacio_contracte")),
    fase: field("fase_publicacio"),
    resultat: field("resultat"),
  };
}

export interface OfficialCheckQuery {
  organ: string;
  url: string;
  ids: string[];
  names: string[];
  candidates: OfficialCheckCandidate[];
}

const soqlLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const CHECK_PAGE_SIZE = 5000;

function checkQueryUrl(organ: string, ids: string[], names: string[], offset: number, pageSize: number): string {
  const supplier: string[] = [];
  if (ids.length) supplier.push(`identificacio_adjudicatari in (${ids.map(soqlLiteral).join(", ")})`);
  if (names.length) supplier.push(`denominacio_adjudicatari in (${names.map(soqlLiteral).join(", ")})`);
  const params = new URLSearchParams({
    $select: [":id", "codi_expedient", "nom_organ", "identificacio_adjudicatari", "denominacio_adjudicatari", "import_adjudicacio_sense", "data_adjudicacio_contracte", "fase_publicacio", "resultat"].join(","),
    $where: `nom_organ = ${soqlLiteral(organ)} AND (fase_publicacio IS NULL OR fase_publicacio != '${ANNULMENT_PHASE}') AND import_adjudicacio_sense is not null AND (${supplier.join(" OR ")})`,
    $order: ":id",
    $limit: String(pageSize),
    $offset: String(offset),
  });
  return `${SODA_RESOURCE}?${params}`;
}

/** Groups the checkable candidates by organ and splits each organ into batches of `batchSize`. */
export function planOfficialChecks(candidates: OfficialCheckCandidate[], options: { batchSize?: number } = {}): OfficialCheckQuery[] {
  const batchSize = options.batchSize ?? 25;
  const byOrgan = new Map<string, OfficialCheckCandidate[]>();
  for (const c of candidates) {
    if (!isCheckable(c)) continue;
    const list = byOrgan.get(c.organ) ?? [];
    list.push(c);
    byOrgan.set(c.organ, list);
  }

  const plan: OfficialCheckQuery[] = [];
  for (const [organ, list] of byOrgan) {
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      const ids = new Set<string>();
      // A name is only queried for a candidate whose id is masked or absent: that is the only way to compare it.
      const maskedNames = new Set<string>();
      for (const c of batch) {
        const sourceId = sourceIdentifier(c.adjudicatariId);
        if (sourceId) ids.add(sourceId);
        else if (c.adjudicatari && c.adjudicatari.trim()) maskedNames.add(c.adjudicatari.trim());
      }
      plan.push({
        organ,
        url: checkQueryUrl(organ, [...ids].sort(), [...maskedNames].sort(), 0, CHECK_PAGE_SIZE),
        ids: [...ids].sort(),
        names: [...maskedNames].sort(),
        candidates: batch,
      });
    }
  }
  return plan;
}

/** Runs `fn` over `items`, at most `concurrency` at a time, keeping the order of the results. */
export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function readAllPages(query: OfficialCheckQuery, deps: HttpDeps, pageSize: number): Promise<SodaValidRecord[]> {
  const records: SodaValidRecord[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const url = offset === 0 ? query.url : checkQueryUrl(query.organ, query.ids, query.names, offset, pageSize);
    const rows = (await fetchJsonWithRetry(url, deps)) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) throw new Error("Unexpected source answer for an official check");
    for (const raw of rows) records.push(toSodaValidRecord(raw));
    if (rows.length < pageSize) break;
  }
  return records;
}

/**
 * Asks the source, organ by organ and at most `concurrency` queries at a time, whether each checkable
 * candidate has a valid record. Returns one answer per checked candidate; the others have none and
 * stay pending.
 */
export async function runOfficialChecks(
  candidates: OfficialCheckCandidate[],
  deps: HttpDeps,
  options: { concurrency?: number; batchSize?: number } = {}
): Promise<OfficialCheckResult[]> {
  const plan = planOfficialChecks(candidates, { batchSize: options.batchSize });
  const answers = await mapPool(plan, options.concurrency ?? 2, async (query) => {
    const records = await readAllPages(query, deps, CHECK_PAGE_SIZE);
    return query.candidates.map((candidate): OfficialCheckResult => {
      const hit = matchValidRecord(candidate, records);
      return {
        organ: candidate.organ,
        codi_expedient: candidate.codiExpedient,
        cif: candidate.keyCif,
        entity_slug: candidate.keySlug,
        lot_number: candidate.lotNumber,
        line_url: candidate.lineUrl,
        found: hit !== null,
        ...(hit ? { record_id: hit.id } : { near_miss: matchNearMiss(candidate, records) !== null }),
      };
    });
  });
  return answers.flat();
}

/** The jsonb argument of decide_contract_annulment_checks(): only the fields the function reads. */
export function buildOfficialCheckPayload(results: OfficialCheckResult[]): string {
  return JSON.stringify(
    results.map(({ near_miss: _nearMiss, ...answer }) => answer)
  );
}
