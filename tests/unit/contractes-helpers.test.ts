/**
 * Unit tests for the contracts-pipeline pure helpers
 * (src/lib/contractes-helpers.ts). These functions decide which CIFs are
 * stored, which amounts are accepted and how values are escaped into SQL —
 * frozen ingest behavior for ~1.7M contracts.
 */
import { describe, expect, it } from "vitest";
import {
  detectEmergency,
  esc,
  escNum,
  isMaskedCif,
  isMultiAwardeeName,
  parseAmount,
  parseCif,
  parseDate,
  parseYear,
} from "../../src/lib/contractes-helpers";

describe("parseCif", () => {
  it("accepts well-formed company CIFs, uppercased and trimmed", () => {
    expect(parseCif("b63197875")).toBe("B63197875");
    expect(parseCif("  A58818501  ")).toBe("A58818501");
    expect(parseCif("Q0801175A")).toBe("Q0801175A");
  });
  it("accepts DNI-shaped ids (sole proprietors) and foreign 2-letter ids", () => {
    expect(parseCif("12345678Z")).toBe("12345678Z");
    expect(parseCif("NL123456789")).toBe("NL123456789");
  });
  it("rejects masked, placeholder and dummy values", () => {
    expect(parseCif("***4567**")).toBeNull();
    expect(parseCif("----")).toBeNull();
    expect(parseCif("DESCONEGUT")).toBeNull();
    expect(parseCif("B00000000")).toBeNull(); // dummy all-zero
    expect(parseCif("")).toBeNull();
    expect(parseCif(undefined)).toBeNull();
  });
  it("rejects structurally invalid values", () => {
    expect(parseCif("B631978")).toBeNull(); // too short
    expect(parseCif("1234567")).toBeNull();
  });
  it("rejects Spanish CIFs with an invalid checksum", () => {
    expect(parseCif("B20202487")).toBeNull(); // Sabico typo; canonical CIF is A20202487
    expect(parseCif("B80605769")).toBeNull(); // Siemens digits swapped; canonical CIF is B60805769
  });
  it("keeps valid Spanish CIFs after checksum validation", () => {
    expect(parseCif("A20202487")).toBe("A20202487");
    expect(parseCif("B60579240")).toBe("B60579240");
  });
  it("validates NIF and NIE control letters", () => {
    expect(parseCif("12345678Z")).toBe("12345678Z");
    expect(parseCif("12345678A")).toBeNull();
    expect(parseCif("X1234567L")).toBe("X1234567L");
    expect(parseCif("X1234567A")).toBeNull();
  });
});

describe("isMultiAwardeeName", () => {
  it("detects explicit multi-awardee separators", () => {
    expect(isMultiAwardeeName("SERVEO SERVICIOS SA || CLECE SA || MULTISERVEIS NDAVANT SL")).toBe(true);
  });
  it("detects very long concatenated names with repeated corporate suffixes", () => {
    const name = [
      "SERVEO SERVICIOS AUXILIARES SA",
      "CLECE SA",
      "MULTISERVEIS NDAVANT SL",
      "ACCIONA FACILITY SERVICES SAU",
      "GESTIO INTEGRAL SCCL",
      "SERVEIS COMPLEMENTARIS UTE",
    ].join(" ".repeat(20));
    expect(name.length).toBeGreaterThan(200);
    expect(isMultiAwardeeName(name)).toBe(true);
  });
  it("keeps simple UTE names as one legal entity", () => {
    expect(isMultiAwardeeName("UTE FISIO BADALONA SA IRITEB SL")).toBe(false);
    expect(isMultiAwardeeName("MULTISERVEIS NDAVANT SL Y CLECE SA UTE")).toBe(false);
  });
});

describe("detectEmergency", () => {
  it("detects strong emergency-procedure wording", () => {
    expect(detectEmergency("Contractació per emergència dels serveis d'hemodiàlisi", null)).toBe(true);
    expect(detectEmergency("Contractació d'emergència dels serveis de transport sanitari", null)).toBe(true);
    expect(detectEmergency("Contractació emergència subministrament material sanitari", null)).toBe(true);
    expect(detectEmergency("Expedient d'emergència per subministrament urgent", "")).toBe(true);
    expect(detectEmergency("Servei ordinari", "Tramitació d'emergència")).toBe(true);
  });
  it("does not flag contracts merely about emergency services", () => {
    expect(detectEmergency("Manteniment del servei d'emergències 112", null)).toBe(false);
    expect(detectEmergency("Contractació del servei d'emergències", null)).toBe(false);
    expect(detectEmergency("Servei d'emergència social municipal", "")).toBe(false);
  });
});

describe("isMaskedCif", () => {
  it("detects asterisk masking anywhere in the value", () => {
    expect(isMaskedCif("***1234**")).toBe(true);
    expect(isMaskedCif("B63*97875")).toBe(true);
  });
  it("detects punctuation-only and placeholder values", () => {
    expect(isMaskedCif("----")).toBe(true);
    expect(isMaskedCif("/")).toBe(true);
    expect(isMaskedCif("NO CONSTA")).toBe(true);
    expect(isMaskedCif("ESTRANGER")).toBe(true);
  });
  it("passes real CIFs through", () => {
    expect(isMaskedCif("B63197875")).toBe(false);
  });
});

describe("parseAmount", () => {
  it("parses positive numbers", () => {
    expect(parseAmount("1234.56")).toBe(1234.56);
  });
  it("rejects zero, negative, NaN and empty — contracts must have a positive amount", () => {
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("-100")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
  });
});

describe("parseYear / parseDate", () => {
  it("extracts the year from ISO-ish strings within 2000–2030", () => {
    expect(parseYear("2021-05-03")).toBe(2021);
    expect(parseYear("1999-01-01")).toBeNull();
    expect(parseYear("2031-01-01")).toBeNull();
    expect(parseYear(undefined)).toBeNull();
  });
  it("parseDate keeps only the YYYY-MM-DD prefix and bounds the year", () => {
    expect(parseDate("2021-05-03T00:00:00.000")).toBe("2021-05-03");
    expect(parseDate("2021-05-03")).toBe("2021-05-03");
    expect(parseDate("03/05/2021")).toBeNull(); // not ISO — rejected here
    expect(parseDate("1995-01-01")).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });
});

describe("esc — SQL literal escaping", () => {
  it("returns NULL for null/undefined", () => {
    expect(esc(null)).toBe("NULL");
    expect(esc(undefined)).toBe("NULL");
  });
  it("doubles single quotes (injection guard)", () => {
    expect(esc("L'HOSPITALET")).toBe("'L''HOSPITALET'");
    expect(esc("a'; DROP TABLE x; --")).toBe("'a''; DROP TABLE x; --'");
  });
  it("doubles backslashes (frozen behavior — see note)", () => {
    // NOTE: under standard_conforming_strings (Postgres default) a doubled
    // backslash is stored as TWO literal backslashes. This is the historical
    // ingest behavior for the rare names containing "\"; frozen as-is so
    // re-syncs stay idempotent. Revisit only together with a data change.
    expect(esc("a\\b")).toBe("'a\\\\b'");
  });
});

describe("escNum", () => {
  it("renders numbers and NULL", () => {
    expect(escNum(12.5)).toBe("12.5");
    expect(escNum(0)).toBe("0");
    expect(escNum(null)).toBe("NULL");
  });
});
