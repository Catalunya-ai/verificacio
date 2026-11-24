/**
 * Unit tests for the grants-pipeline pure helpers
 * (src/lib/raisc-helpers.ts). These functions decide identifier
 * classification (CIF vs DNI/NIE — privacy-critical), date/amount parsing and
 * the row→entity / row→grant mapping for ~19.5M RAISC records.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  RETRY_ATTEMPTS_DEFAULT,
  classifyIdentifier,
  getCif,
  getEntityName,
  getEntitySlug,
  isCompanyCif,
  isNonPublishable,
  mapToEntity,
  mapToGrant,
  parseAmount,
  parseDate,
  parseTerritorial,
  retryDelayMs,
  withRetry,
  type RaiscRow,
} from "../../src/lib/raisc-helpers";

/** Minimal publishable company row; tests override fields as needed. */
function row(overrides: Partial<RaiscRow> = {}): RaiscRow {
  return {
    clau: "K-001",
    codi_bdns: "123456",
    ra_social_del_beneficiari: "FUNDACIO EXEMPLE",
    cif_beneficiari: "G12345678",
    tipus_de_beneficiaris_codi: "JSA",
    import_subvenci_pr_stec_ajut: "10000",
    data_concessi: "2021-06-15",
    any_de_la_convocat_ria: "2021",
    departament_o_entitat_local_d_adscripci_: "Departament de Cultura",
    finalitat_rais: "CULTURA",
    codi_territorial: "13_08",
    ajut_d_estat: "No",
    ...overrides,
  } as RaiscRow;
}

describe("classifyIdentifier — privacy-critical routing", () => {
  it("classifies DNI and NIE as person identifiers (never stored as CIF)", () => {
    expect(classifyIdentifier("12345678Z").type).toBe("dni");
    expect(classifyIdentifier("X1234567L").type).toBe("nie");
    expect(classifyIdentifier("z7654321b").type).toBe("nie"); // case-insensitive
  });
  it("classifies anonymized asterisk patterns", () => {
    expect(classifyIdentifier("***8736**").type).toBe("anonymized");
  });
  it("classifies blocked placeholder CIFs", () => {
    expect(classifyIdentifier("A00000000").type).toBe("blocked");
    expect(classifyIdentifier("B0000000").type).toBe("blocked");
  });
  it("classifies and normalizes company CIFs; only the cif variant carries `normalized`", () => {
    const r = classifyIdentifier(" b63197875 ");
    expect(r).toEqual({ type: "cif", normalized: "B63197875", prefix: "B", raw: "B63197875" });
  });
  it("routes T-prefix and unrecognized formats to unknown (org-by-name)", () => {
    expect(classifyIdentifier("T1234567A").type).toBe("unknown");
    expect(classifyIdentifier("").type).toBe("unknown");
    expect(classifyIdentifier(null).type).toBe("unknown");
  });
});

describe("isCompanyCif", () => {
  it("accepts company prefixes incl. K/L/M, rejects digits and empty", () => {
    expect(isCompanyCif("B63197875")).toBe(true);
    expect(isCompanyCif("K1234567A")).toBe(true);
    expect(isCompanyCif("12345678Z")).toBe(false);
    expect(isCompanyCif(null)).toBe(false);
  });
});

describe("parseDate — three RAISC source formats", () => {
  it("DD/MM/YYYY (CSV) with zero-padding", () => {
    expect(parseDate("5/3/2021")).toBe("2021-03-05");
    expect(parseDate("15/12/2020")).toBe("2020-12-15");
  });
  it("ISO and SODA floating timestamps", () => {
    expect(parseDate("2021-03-05")).toBe("2021-03-05");
    expect(parseDate("2021-03-05T00:00:00.000")).toBe("2021-03-05");
  });
  it("junk → null", () => {
    expect(parseDate("ahir")).toBeNull();
    expect(parseDate("")).toBeNull();
  });
});

describe("parseAmount", () => {
  it("parses numbers; empty/NaN → 0 (mapToGrant rejects ≤0 downstream)", () => {
    expect(parseAmount("123.45")).toBe(123.45);
    expect(parseAmount("")).toBe(0);
    expect(parseAmount("abc")).toBe(0);
  });
});

describe("isNonPublishable / entity name & slug & cif", () => {
  it("explicit 'Benef. no publicable' marker", () => {
    expect(isNonPublishable(row({ cif_beneficiari: "Benef. no publicable" }))).toBe(true);
  });
  it("FSA rows with a non-generic name are treated as persons (non-publishable)", () => {
    const r = row({ tipus_de_beneficiaris_codi: "FSA", ra_social_del_beneficiari: "Jordi Garcia Puig" });
    expect(isNonPublishable(r)).toBe(true);
    expect(getEntityName(r)).toBe("Benef. no publicable (Departament de Cultura)");
    expect(getEntitySlug(r)).toBe("BENEF-NO-PUBLICABLE-DEPARTAMENT-DE-CULTURA");
    expect(getCif(r)).toBeNull(); // never expose a person identifier
  });
  it("FSA rows with known-safe generic buckets stay publishable", () => {
    expect(
      isNonPublishable(row({ tipus_de_beneficiaris_codi: "FSA", ra_social_del_beneficiari: "Persona física" }))
    ).toBe(false);
  });
  it("publishable company rows keep name/slug/cif", () => {
    const r = row();
    expect(getEntityName(r)).toBe("FUNDACIO EXEMPLE");
    expect(getEntitySlug(r)).toBe("FUNDACIO-EXEMPLE");
    expect(getCif(r)).toBe("G12345678");
  });
  it("getCif rejects short values", () => {
    expect(getCif(row({ cif_beneficiari: "12345" }))).toBeNull();
  });
});

describe("parseTerritorial (no cache loaded — code fallback)", () => {
  it("splits comarca_province codes", () => {
    expect(parseTerritorial("13_08")).toEqual({ comarcaCode: "13", provinceCode: "08", comarcaName: null });
  });
  it("empty or malformed → nulls", () => {
    expect(parseTerritorial("")).toEqual({ comarcaCode: null, provinceCode: null, comarcaName: null });
    expect(parseTerritorial("garbage")).toEqual({ comarcaCode: null, provinceCode: null, comarcaName: null });
  });
});

describe("mapToGrant — row acceptance rules", () => {
  it("rejects non-positive amounts", () => {
    expect(mapToGrant(row({ import_subvenci_pr_stec_ajut: "0" }), "X")).toBeNull();
    expect(mapToGrant(row({ import_subvenci_pr_stec_ajut: "-5" }), "X")).toBeNull();
  });
  it("rejects years outside RAISC coverage (2016–2030)", () => {
    expect(mapToGrant(row({ data_concessi: "2015-12-31" }), "X")).toBeNull();
    expect(mapToGrant(row({ data_concessi: "2031-01-01" }), "X")).toBeNull();
  });
  it("derives year from grant date, falling back to convocatòria year", () => {
    const g1 = mapToGrant(row(), "FUNDACIO-EXEMPLE")!;
    expect(g1.grant_year).toBe(2021);
    expect(g1.grant_date).toBe("2021-06-15");
    const g2 = mapToGrant(row({ data_concessi: "", any_de_la_convocat_ria: "2019" }), "X")!;
    expect(g2.grant_year).toBe(2019);
    expect(g2.grant_date).toBeNull();
  });
  it("maps flags and provenance fields", () => {
    const g = mapToGrant(
      row({ ajut_d_estat: "Sí", finalitat_rais: "CRÈDIT OFICIAL I SUPORT FINANCER" }),
      "FUNDACIO-EXEMPLE"
    )!;
    expect(g.is_state_aid).toBe(true);
    expect(g.is_credit).toBe(true);
    expect(g.source_dataset).toBe("raisc_concessions");
    expect(g.raisc_clau).toBe("K-001");
    expect(g.entity_slug).toBe("FUNDACIO-EXEMPLE");
  });
  it("sets the Catalan ccaa_code required by aggregation", () => {
    const g = mapToGrant(row(), "FUNDACIO-EXEMPLE")!;
    expect(g.ccaa_code).toBe("CAT");
    expect(g.ccaa_code).not.toBeNull();
    expect(g.ccaa_code).not.toBe("");
  });
});

describe("mapToEntity", () => {
  it("maps slug, name, cif and territorial fallback", () => {
    expect(mapToEntity(row())).toEqual({
      slug: "FUNDACIO-EXEMPLE",
      name: "FUNDACIO EXEMPLE",
      cif: "G12345678",
      comarca_code: "13",
      province_code: "08",
      comarca: null,
      beneficiary_type: "JSA",
    });
  });
});

describe("withRetry — un tall de xarxa curt no atura la càrrega", () => {
  // Les esperes reals sumarien 61 s dins de la suite; la corba es prova a part.
  beforeAll(() => vi.stubEnv("RAISC_RETRY_BASE_DELAY_MS", "1"));
  afterAll(() => vi.unstubAllEnvs());

  // Amb 3 intents i attempt*500 la cobertura seria d'1,5 s; un tall de 5-10 s
  // durant una càrrega de diverses hores ha de cabre dins dels reintents.
  it("creix exponencialment amb sostre de 30 s i cobreix ~1 min de tall continuat", () => {
    const delays = Array.from({ length: RETRY_ATTEMPTS_DEFAULT - 1 }, (_, i) => retryDelayMs(i + 1));
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(delays.reduce((a, b) => a + b, 0)).toBe(61_000);
  });

  it("no passa mai del sostre, per lluny que vagi l'intent", () => {
    expect(retryDelayMs(20)).toBe(30_000);
    expect(retryDelayMs(100)).toBe(30_000);
  });

  it("(a) es recupera despres de N fallades de xarxa", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 5) throw new Error("TypeError: fetch failed");
        return "ok";
      },
      undefined,
      "prova-recuperacio"
    );
    expect(result).toBe("ok");
    expect(calls).toBe(5);
  });

  it("(b) un error d'SQL NO es reintenta: peta a la primera", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('duplicate key value violates unique constraint "entities_slug_key"');
        },
        undefined,
        "prova-sql"
      )
    ).rejects.toThrow(/entities_slug_key/);
    expect(calls).toBe(1);
  });

  it("(d) també reintenta els talls de socket del client de PostgreSQL", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("read ECONNRESET");
        return "ok";
      },
      undefined,
      "prova-socket"
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("(c) esgota els intents i propaga l'error original", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("TypeError: fetch failed");
        },
        undefined,
        "prova-esgotament"
      )
    ).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(RETRY_ATTEMPTS_DEFAULT);
  });
});
