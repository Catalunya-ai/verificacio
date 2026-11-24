import { describe, expect, it as test } from "vitest";
import {
  isValidCif,
  isAnonymizedNif,
  looksLikePersonalName,
  redactPersonalData,
} from "../../src/lib/privacy";

/**
 * Unit tests for src/lib/privacy.ts — personal-data guards used by the loaders.
 *
 * Run: npx vitest run tests/unit/privacy.test.ts
 */

describe("isValidCif()", () => {
  test("accepts all 15 valid first letters", () => {
    const valid = "ABCDEFGHJNPQRSUVW";
    for (const L of valid) {
      expect(isValidCif(`${L}12345678`), `${L} should be valid`).toBe(true);
    }
  });

  test("rejects NIF/DNI/NIE first letters", () => {
    // K, L, M = NIF; X, Y, Z = NIE; T = resident; I, O = unassigned
    for (const L of "KLMTXYZIO") {
      expect(isValidCif(`${L}1234567A`), `${L} should be rejected`).toBe(false);
    }
  });

  test("rejects malformed CIFs", () => {
    expect(isValidCif(null)).toBe(false);
    expect(isValidCif("")).toBe(false);
    expect(isValidCif("A1234567")).toBe(false);         // 8 chars
    expect(isValidCif("A123456789")).toBe(false);       // 10 chars
    expect(isValidCif("A1234567K")).toBe(false);        // control K not in 0-9A-J
    expect(isValidCif("123456789")).toBe(false);        // no letter
  });

  test("accepts CIF with letter control char 0-J", () => {
    expect(isValidCif("A12345670")).toBe(true);
    expect(isValidCif("A1234567A")).toBe(true);
    expect(isValidCif("A1234567J")).toBe(true);
  });

  test("accepts lowercase after normalization", () => {
    expect(isValidCif("a12345678")).toBe(true);
    expect(isValidCif("  A12345678  ")).toBe(true);
  });
});

describe("isAnonymizedNif()", () => {
  test("detects asterisk masking (BCN CKAN pattern)", () => {
    expect(isAnonymizedNif("****3292*")).toBe(true);
    expect(isAnonymizedNif("***3292**")).toBe(true);
    expect(isAnonymizedNif("*")).toBe(true);
  });

  test("detects X-masking", () => {
    expect(isAnonymizedNif("XXXX3292X")).toBe(true);
    expect(isAnonymizedNif("XXX1234XX")).toBe(true);
  });

  test("does not mistake valid CIFs for anonymised NIFs", () => {
    expect(isAnonymizedNif("A12345678")).toBe(false);
    expect(isAnonymizedNif("B99999999")).toBe(false);
  });

  test("handles null/empty", () => {
    expect(isAnonymizedNif(null)).toBe(false);
    expect(isAnonymizedNif("")).toBe(false);
    expect(isAnonymizedNif("   ")).toBe(false);
  });
});

describe("looksLikePersonalName()", () => {
  test("detects honorifics", () => {
    expect(looksLikePersonalName("Sr. Jordi Garcia")).toBe(true);
    expect(looksLikePersonalName("SRA. Maria Lopez")).toBe(true);
    expect(looksLikePersonalName("D. Pere Martinez")).toBe(true);
    expect(looksLikePersonalName("Don Pedro García")).toBe(true);
  });

  test("detects 3-token Catalan names", () => {
    expect(looksLikePersonalName("JORDI GARCIA LOPEZ")).toBe(true);
    expect(looksLikePersonalName("Maria del Mar Ferrer")).toBe(true);
    expect(looksLikePersonalName("Pere i Jordi Soler")).toBe(true);
  });

  test("excludes when org keyword present", () => {
    expect(looksLikePersonalName("FUNDACIO PAU CASALS")).toBe(false);
    expect(looksLikePersonalName("Associació Jordi Salvat")).toBe(false);
    expect(looksLikePersonalName("Consorci Maria Ferrer")).toBe(false);
    expect(looksLikePersonalName("CIDOB SA")).toBe(false);
    expect(looksLikePersonalName("INSTITUT RAMON LLULL")).toBe(false);
    expect(looksLikePersonalName("Federació Pau Casals")).toBe(false);
  });

  test("excludes single tokens and very long strings", () => {
    expect(looksLikePersonalName("JORDI")).toBe(false);
    expect(looksLikePersonalName("X".repeat(210))).toBe(false);
  });

  test("handles null/empty", () => {
    expect(looksLikePersonalName(null)).toBe(false);
    expect(looksLikePersonalName("")).toBe(false);
  });

  test("excludes lowercase narrative text", () => {
    expect(looksLikePersonalName("despeses per capita")).toBe(false);
    expect(looksLikePersonalName("transferències corrents")).toBe(false);
  });
});

describe("redactPersonalData()", () => {
  test("keeps valid CIFs visible", () => {
    const row = { cif: "A12345678", name: "FUNDACIO CIDOB" };
    const out = redactPersonalData(row);
    expect(out.cif).toBe("A12345678");
    expect(out.name).toBe("FUNDACIO CIDOB");
  });

  test("masks invalid/NIF-shaped IDs keeping last 4", () => {
    const out = redactPersonalData({ raw_cif: "Z9999999A" });
    expect(out.raw_cif).toBe("****999A");
  });

  test("masks anonymised NIF", () => {
    const out = redactPersonalData({ raw_cif: "****3292*" });
    expect(out.raw_cif).toBe("****292*");
  });

  test("redacts personal-name beneficiaris", () => {
    const out = redactPersonalData({ beneficiari: "JORDI GARCIA LOPEZ" });
    expect(out.beneficiari).toBe("[REDACTED-NAME]");
  });

  test("leaves non-sensitive fields untouched", () => {
    const out = redactPersonalData({
      amount: 12345,
      program_code: "2329",
      year: 2024,
    });
    expect(out.amount).toBe(12345);
    expect(out.program_code).toBe("2329");
    expect(out.year).toBe(2024);
  });

  test("does not mutate input", () => {
    const row = { cif: "Z9999999A", beneficiari: "JORDI GARCIA LOPEZ" };
    redactPersonalData(row);
    expect(row.cif).toBe("Z9999999A");
    expect(row.beneficiari).toBe("JORDI GARCIA LOPEZ");
  });
});
