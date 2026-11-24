/**
 * Pure helpers for the contractes.cat sync pipeline (sync-contractes.ts).
 *
 * Extracted verbatim from sync-contractes.ts so they can be unit-tested:
 * the sync script executes main() on import, which makes it untestable
 * directly. Behavior is FROZEN — these functions shape what gets written to
 * the contracts table; changing them changes ingest semantics.
 */

import { isDummyCif } from "./privacy";

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const CIF_CONTROL_LETTERS = "JABCDEFGHI";
const CIF_NUMERIC_CONTROL_TYPES = new Set(["A", "B", "E", "H"]);
const CIF_LETTER_CONTROL_TYPES = new Set(["N", "P", "Q", "R", "S", "W"]);
const KNOWN_INVALID_SPANISH_IDS = new Set(["B20202487", "B80605769"]);

export function parseCif(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim().toUpperCase();
  // Reject masked/placeholder CIFs (GDPR practice by some organs)
  if (isMaskedCif(trimmed)) return null;
  // Reject dummy all-zero CIFs (A00000000, B00000000, etc.) — structurally
  // valid under the regex but clearly sentinel values for "no real CIF"
  if (isDummyCif(trimmed)) return null;
  // A/B legal-form swaps are not detectable from the CIF checksum alone.
  if (KNOWN_INVALID_SPANISH_IDS.has(trimmed)) return null;
  if (/^\d{8}[A-Z]$/.test(trimmed)) return isValidNif(trimmed) ? trimmed : null;
  if (/^[XYZ]\d{7}[A-Z]$/.test(trimmed)) return isValidNie(trimmed) ? trimmed : null;
  if (/^[A-Z]\d{7}[A-Z0-9]$/.test(trimmed)) return isValidSpanishCif(trimmed) ? trimmed : null;
  if (/^[A-Z]{2}\d{5,}$/.test(trimmed)) return trimmed;
  return null;
}

function isValidNif(nif: string): boolean {
  const num = Number(nif.slice(0, 8));
  const expected = NIF_LETTERS[num % 23];
  return nif[8] === expected;
}

function isValidNie(nie: string): boolean {
  const prefix = { X: "0", Y: "1", Z: "2" }[nie[0] as "X" | "Y" | "Z"];
  return isValidNif(`${prefix}${nie.slice(1)}`);
}

function isValidSpanishCif(cif: string): boolean {
  const type = cif[0];
  const digits = cif.slice(1, 8).split("").map((d) => Number(d));
  const control = cif[8];

  const total = digits.reduce((sum, digit, index) => {
    if (index % 2 === 0) {
      const doubled = digit * 2;
      return sum + Math.floor(doubled / 10) + (doubled % 10);
    }
    return sum + digit;
  }, 0);

  const controlNumber = (10 - (total % 10)) % 10;
  const controlDigit = String(controlNumber);
  const controlLetter = CIF_CONTROL_LETTERS[controlNumber];

  if (CIF_NUMERIC_CONTROL_TYPES.has(type)) return control === controlDigit;
  if (CIF_LETTER_CONTROL_TYPES.has(type)) return control === controlLetter;
  return control === controlDigit || control === controlLetter;
}

/** Detect GDPR-masked or placeholder CIFs from SODA contract data */
export function isMaskedCif(cif: string): boolean {
  // Patterns seen in contractes.cat: *, **, ***, ----, /, etc.
  if (/^[*\-/.\s]+$/.test(cif)) return true;
  // "*** XXXX **" pattern (partially masked)
  if (cif.includes("*")) return true;
  // Common placeholders
  if (["DESCONEGUT", "ESTRANGER", "VARIOS", "DIVERSE", "NO CONSTA"].includes(cif)) return true;
  return false;
}

export function isMultiAwardeeName(name: string): boolean {
  const normalized = name.trim().toUpperCase();
  if (!normalized) return false;
  if (normalized.includes("||")) return true;
  if (normalized.length <= 200) return false;

  const suffixes = normalized.match(/\b(SAU|SLU|SCCL|UTE|SA|SL)\b/g) || [];
  return suffixes.length >= 3;
}

export function detectEmergency(
  description: string | null | undefined,
  procedureType: string | null | undefined
): boolean {
  const procedure = normalizeForPattern(procedureType);
  if (/\bemerg/.test(procedure)) return true;

  const text = normalizeForPattern(description);
  return [
    /\btramitacio\s+d['' ]?\s*emergencia\b/,
    /\b(?:contractacio|adjudicacio|tramitacio)\s+(?:d['' ]?\s*)?emergencia\b/,
    /\bcontractacio\s+per\s+(?:l['' ]?\s*)?emergencia\b/,
    /\badjudicacio\s+per\s+(?:l['' ]?\s*)?emergencia\b/,
    /\bper\s+la\s+via\s+d['' ]?\s*emergencia\b/,
    /^emergencia[\s:]/,
    /\bexpedient\s+d['' ]?\s*emergencia\b/,
    /\bprocediment\s+d['' ]?\s*emergencia\b/,
  ].some((pattern) => pattern.test(text));
}

function normalizeForPattern(value: string | null | undefined): string {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’´`]/g, "'");
}

export function parseAmount(val: string | undefined): number | null {
  if (!val) return null;
  const num = parseFloat(val);
  return isNaN(num) || num <= 0 ? null : num;
}

export function parseYear(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const year = parseInt(dateStr.substring(0, 4), 10);
  return isNaN(year) || year < 2000 || year > 2030 ? null : year;
}

export function parseDate(dateStr: string | undefined): string | null {
  if (!dateStr) return null;
  const match = dateStr.match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) return null;
  const year = parseInt(match[0].substring(0, 4), 10);
  if (year < 2000 || year > 2030) return null;
  return match[0];
}

/** Escape a string for SQL single-quoted literal */
export function esc(val: string | null | undefined): string {
  if (val === null || val === undefined) return "NULL";
  return "'" + val.replace(/'/g, "''").replace(/\\/g, "\\\\") + "'";
}

export function escNum(val: number | null): string {
  if (val === null || val === undefined) return "NULL";
  return String(val);
}
