/**
 * privacy.ts
 *
 * Helpers for identifier and placeholder checks. The loaders use
 * `isPlaceholderBeneficiaryName` and `isDummyCif`; the others are tested utilities.
 *
 * Four primitives:
 *   - `isValidCif(s)` — Spanish CIF structural validator (BOE Orden EHA/451/2008).
 *   - `isAnonymizedNif(s)` — detect masked personal IDs like `****3292*`.
 *   - `looksLikePersonalName(s)` — heuristic: honorifics + `Nom Cognom Cognom`
 *     patterns lacking an organisation keyword. Used to suppress indexing.
 *   - `redactPersonalData(row)` — mask raw_name / raw_cif fields for logging.
 *
 * These exist because some open-data sources publish masked NIFs for a large
 * share of rows, and free-text fields can contain unmasked personal names
 * despite the NIF being redacted.
 */

// ─── CIF validator (BOE Orden EHA/451/2008) ──────────────────────────────────

/**
 * Spanish CIF structural validator.
 *
 * Accepts 15 valid first letters (entity type):
 *   A, B, C, D, E, F, G, H, J, N, P, Q, R, S, U, V, W
 * Followed by 7 digits and 1 control character (digit 0-9 or letter A-J).
 *
 * Does NOT validate the control character math — that's a stronger check, but
 * the regex form is the canonical gate used across the codebase.
 *
 * Explicitly rejects NIF/DNI/NIE first letters (K, L, M, T, X, Y, Z, I, O).
 */
export function isValidCif(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = raw.trim().toUpperCase();
  return /^[ABCDEFGHJNPQRSUVW][0-9]{7}[0-9A-J]$/.test(s);
}

/**
 * Detect anonymised-NIF patterns published by the sources:
 *   - `****3292*` (asterisk-masked DNI)
 *   - `***3292**`
 *   - `XXXX3292X` (uppercase X-masked)
 *   - any string containing `*` or three consecutive X/x padding digits
 *
 * True = the upstream has intentionally masked a personal ID. Such identifiers are not stored as CIF.
 */
export function isAnonymizedNif(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = raw.trim();
  if (s.length === 0) return false;
  if (s.includes("*")) return true;
  // Three consecutive X's (case-insensitive) adjacent to digits.
  if (/[Xx]{3,}\d|\d[Xx]{3,}/.test(s)) return true;
  return false;
}

// ─── Personal-name heuristic ─────────────────────────────────────────────────

// Organisation keywords — if any appears, the string is NOT treated as a
// personal name. Catalan + Spanish + English variants seen in BCN CSVs.
const ORG_KEYWORDS = [
  "FUNDACIO", "FUNDACIÓ", "FUNDACION", "FUNDACIÓN",
  "ASSOCIACIO", "ASSOCIACIÓ", "ASOCIACION", "ASOCIACIÓN",
  "CONSORCI", "CONSORCIO",
  "INSTITUT", "INSTITUTO", "INSTITUTE",
  "SA", "SL", "SLU", "SLL", "SLP", "SCP", "SCCL", "SCR",
  "SOCIETAT", "SOCIEDAD",
  "COOP", "COOPERATIVA",
  "FED", "FEDERACIO", "FEDERACIÓ", "FEDERACION",
  "UNIO", "UNIÓ", "UNION",
  "AGRUPACIO", "AGRUPACIÓ", "AGRUPACION",
  "COL·LEGI", "COLEGIO", "COL·LEGI",
  "SINDICAT", "SINDICATO",
  "CAMBRA", "CAMARA",
  "AJUNTAMENT", "DIPUTACIO", "DIPUTACIÓ", "GENERALITAT",
  "UNIVERSITAT", "UNIVERSIDAD", "UNIVERSITY",
  "ESGLESIA", "ESGLÉSIA", "IGLESIA",
  "CLUB", "CENTRE", "CENTRO",
  "GRUP", "GRUPO",
  "PARTIT", "PARTIDO",
  "ONG", "ONGD",
  "EMPRESA", "COMPANYIA", "COMPAÑIA",
  "ENT", "ENTITAT", "ENTIDAD",
  "MUSEU", "MUSEO",
  "HOSPITAL", "CLINICA", "CLÍNICA",
  "ESCOLA", "ESCUELA", "SCHOOL",
  "ATENEU", "CASAL",
];

const ORG_KEYWORD_RE = new RegExp(
  "(?:^|[^\\p{L}])(?:" + ORG_KEYWORDS.join("|") + ")(?:[^\\p{L}]|$)",
  "iu"
);

const HONORIFIC_RE = /^(SR\.?|SRA\.?|D\.?|DNA\.?|DON|DOÑA|DONYA|MR\.?|MRS\.?|MS\.?)\b/iu;

/**
 * Heuristic: does this text look like a raw personal name (vs. an
 * organisation)?
 *
 * Returns true when:
 *   - the string starts with an honorific (SR., SRA., D., DNA., DON, DOÑA…), OR
 *   - the string consists of 2-5 capitalised tokens with no organisation
 *     keyword (e.g. "JORDI GARCIA LOPEZ").
 *
 * Callers can use it to leave the free-text field empty; the amounts and
 * codes are still kept for the aggregates.
 */
export function looksLikePersonalName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = raw.trim();
  if (s.length === 0 || s.length > 200) return false;

  if (HONORIFIC_RE.test(s)) return true;

  // If any org keyword is present, it's an organisation.
  if (ORG_KEYWORD_RE.test(s)) return false;

  // Tokenize on whitespace; require 2-5 tokens all starting with a letter
  // and either fully uppercase or Title Case. Allow particles (de, del, la,
  // i, y, dels, les) between capitalised tokens.
  const particles = new Set([
    "DE", "DEL", "LA", "LAS", "LOS", "EL", "I", "Y", "DELS", "LES", "DU", "D",
    "DA", "DO", "DOS", "DAS", "VAN", "VON", "DER", "BIN", "BEN",
  ]);
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;

  let capitalised = 0;
  for (const t of tokens) {
    const up = t.replace(/[.,]/g, "").toUpperCase();
    if (particles.has(up)) continue;
    // Token must start with an uppercase letter (after possibly stripping
    // diacritics). Accept any unicode letter.
    if (!/^\p{Lu}/u.test(t)) return false;
    capitalised++;
  }
  // Need at least 2 non-particle capitalised tokens to qualify as a name.
  return capitalised >= 2;
}

// ─── Placeholder beneficiary names ───────────────────────────────────────────

/**
 * Catalan public contract CSVs (contractes.cat SODA) frequently
 * ship rows where `denominacio_adjudicatari` is literal pointer text instead
 * of a real company name — "Veure documents adjunts", "Diverses empreses",
 * "Hi ha 15 empreses adjudicatàries", "Varies empreses a homologar veure
 * resolució", etc.
 *
 * Earlier ingests slugified these blindly, producing ghost entities like
 * `VEURE-ELS-DOCUMENTS-ADJUNTS` that then showed up as top beneficiaries.
 * Ingest must skip these rows entirely: the amount is aggregated at framework
 * level elsewhere, so we'd rather drop them than attribute them to a fake
 * entity. Callers should both (a) NOT create an `entities` row, and (b) NOT
 * insert the contract.
 *
 * Carefully designed to avoid false positives: real firms start with
 * "Consultoria…", "Consulting…", "DIVERSOS, SCP" (real coop CIF J55737324).
 * We only match (i) `Veure|Vegeu + <generic pointer word>`, (ii) the exact
 * tokens `Diverses` / `Diversos`, (iii) specific multi-word phrases.
 */
const PLACEHOLDER_POINTER_WORDS = [
  "RESOLUCIO", "RESOLUCIÓ", "RESOL",         // "Veure resol·adjudicació"
  "DOCUMENT", "DOCUMENTS",
  "DECRET", "DECRETS",                        // plural seen
  "ANUNCI", "ANUNCIS",
  "ANNEX", "ANNEXOS", "ANEXO",
  "ACORD", "ACORDS",
  "ADJUDICACIO", "ADJUDICACIÓ",
  "ARXIU", "ARXIUS",
  "EXCEL",
  "APARTAT",
  "ART",
  "LA",    // "Veure la resolució"
  "ELS",   // "Veure els documents"
  "LES",
  "EL",
];

const PLACEHOLDER_PREFIX_RE = new RegExp(
  `^(?:VEURE|VEGEU|CONSULTAR)\\s+(?:${PLACEHOLDER_POINTER_WORDS.join("|")})\\b`,
  "iu",
);

const PLACEHOLDER_EXACT = new Set([
  "DIVERSES",
  "DIVERSOS",
  "DIVERSES EMPRESES",
  "DIVERSOS PROVEIDORS",
  "DIVERSOS PROVEÏDORS",
  "EMPRESES DIVERSES",
  "PENDENT D'ADJUDICAR",
  "PENDENT D ADJUDICAR",
  "PENDIENTE DE ADJUDICAR",
  "VARIOS",
  "NO CONSTA",
]);

const PLACEHOLDER_CONTAINS_RE =
  /\b(?:HI\s+HA\s+\d+\s+EMPRESES|VARIES\s+EMPRESES\s+A\s+HOMOLOGAR|ELS?\s+QUE\s+CONSTEN|LES\s+QUE\s+CONSTEN|ELS\s+EXPRESSATS|ELS\s+INDICATS|EMPRESES\s+ADJUDICATARIES\s+SON\s+LES\s+QUE\s+CONSTEN|DIVERSES\s+EMPRESES\s+(?:VEURE|RELACIONADES|ADJUDICADORES)|DIVERSOS\s+PROVEIDORS\s+VEURE|PLURALITAT\s+D'?EMPRESES|MULTIPLES\s+ADJUDIC)\b/iu;

/**
 * True if `name` is a CSV pointer phrase rather than a real beneficiary.
 * Compare case-insensitively on the raw (non-slugified) text.
 */
export function isPlaceholderBeneficiaryName(
  raw: string | null | undefined,
): boolean {
  if (!raw) return false;
  const s = raw.trim();
  if (s.length === 0) return false;
  const upper = s.toUpperCase().replace(/\s+/g, " ");
  if (PLACEHOLDER_EXACT.has(upper)) return true;
  if (PLACEHOLDER_PREFIX_RE.test(s)) return true;
  if (PLACEHOLDER_CONTAINS_RE.test(s)) return true;
  return false;
}

/**
 * Dummy / sentinel CIFs seen in contractes.cat when the adjudicatari field
 * is a pointer phrase. Structurally valid under the CIF regex but clearly
 * fake (all-zeros body). Callers should treat these as "no CIF".
 */
const DUMMY_CIF_RE = /^[A-Z]0{7}[0-9A-J]$|^0{8}[A-Z]$|^0{9,}$/;

export function isDummyCif(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return DUMMY_CIF_RE.test(raw.trim().toUpperCase());
}

// ─── Log redaction ───────────────────────────────────────────────────────────

/**
 * Redact a loggable row to remove raw personal identifiers before emission.
 * Works on any object shape — fields named `cif`, `nif`, `raw_cif`,
 * `raw_name`, `beneficiari*`, `name` are masked.
 *
 * Valid CIFs are kept (organisational IDs are public). Invalid-CIF strings
 * and anything NIF-shaped are masked to `****XXXX*`.
 *
 * Never mutates the input.
 */
export function redactPersonalData<T extends Record<string, unknown>>(row: T): T {
  const SENSITIVE_FIELDS = new Set([
    "cif", "nif", "raw_cif", "raw_nif",
    "raw_name", "name", "beneficiari", "beneficiaria",
    "beneficiaris", "beneficiarios", "text_subconcepte",
  ]);
  const out: Record<string, unknown> = { ...row };
  for (const [k, v] of Object.entries(out)) {
    const key = k.toLowerCase();
    if (!SENSITIVE_FIELDS.has(key)) continue;
    if (v == null) continue;
    if (typeof v !== "string") continue;

    if (key === "cif" || key === "raw_cif" || key === "nif" || key === "raw_nif") {
      out[k] = isValidCif(v) ? v : maskId(v);
      continue;
    }
    // Names / free-text — redact if it looks personal.
    if (looksLikePersonalName(v)) {
      out[k] = "[REDACTED-NAME]";
    }
  }
  return out as T;
}

function maskId(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 4) return "****";
  // Keep last 4 chars — enough for operator debugging, insufficient for
  // re-identification.
  return "****" + trimmed.slice(-4);
}
