/**
 * Tests de les parts pures de la càrrega d'anul·lacions oficials de contractes
 * (src/lib/contract-annulments.ts): lectura de pàgines amb reintents, normalització de
 * línies (inclosos els imports `||||` de les publicacions amb diversos proveïdors), clau estable,
 * classificació del resultat i comprovació d'una publicació vàlida (regla 4). Tot amb fixtures
 * sintètiques: cap xarxa, cap base de dades.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANNULMENT_PAGE_SIZE,
  annulmentPageUrl,
  buildLinesUpsertSql,
  buildOfficialCheckPayload,
  dollarQuoted,
  entityRecomputeSql,
  fetchAnnulmentLines,
  fetchJsonWithRetry,
  isNotAwardedResultat,
  matchValidRecord,
  normalizeAnnulmentLine,
  parsePlainAmount,
  planOfficialChecks,
  runOfficialChecks,
  type AnnulmentLine,
  type OfficialCheckCandidate,
  type SodaValidRecord,
} from "../../src/lib/contract-annulments";

// ── Fixtures ──────────────────────────────────────────────────────────────

const RAW_PLAIN = {
  codi_expedient: " EXP-0001 ",
  nom_organ: "Organ Sintetic A",
  identificacio_adjudicatari: "X0000001Z",
  denominacio_adjudicatari: "Proveidor Sintetic SL",
  import_adjudicacio_sense: "885",
  data_adjudicacio_contracte: "2024-01-02T00:00:00.000",
  enllac_publicacio: { url: "https://example.invalid/detall-publicacio/aaa/111" },
  es_agregada: "SÍ",
  data_publicacio_anul: "2025-12-04T13:12:00.000",
};

const RAW_WITHDRAWN = { ...RAW_PLAIN, codi_expedient: "EXP-0002", resultat: "Desistiment" };

const RAW_MULTI_SUPPLIER = {
  ...RAW_PLAIN,
  codi_expedient: "EXP-0003",
  import_adjudicacio_sense: "||||||||",
  identificacio_adjudicatari: "||||||||",
};

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: String(status),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

type FakeFetch = (url: string) => Promise<ReturnType<typeof response>>;

function scripted(responses: Array<ReturnType<typeof response>>): { fetchFn: FakeFetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetchFn: FakeFetch = async (url) => {
    calls.push(url);
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return next;
  };
  return { fetchFn, calls };
}

function recorderSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

// ── parsePlainAmount ──────────────────────────────────────────────────────

describe("parsePlainAmount", () => {
  it("accepta els imports numèrics simples", () => {
    expect(parsePlainAmount("885")).toBe(885);
    expect(parsePlainAmount("211.2")).toBe(211.2);
    expect(parsePlainAmount(" 1070.85 ")).toBe(1070.85);
  });

  it("torna null quan l'import no és un número simple: `||||` de diversos proveïdors, buit, absent, separadors", () => {
    expect(parsePlainAmount("||||||||")).toBeNull();
    expect(parsePlainAmount("100||200")).toBeNull();
    expect(parsePlainAmount("")).toBeNull();
    expect(parsePlainAmount(undefined)).toBeNull();
    expect(parsePlainAmount("1.234,50")).toBeNull();
    expect(parsePlainAmount("12abc")).toBeNull();
  });
});

// ── isNotAwardedResultat ──────────────────────────────────────────────────

describe("isNotAwardedResultat", () => {
  it("només Desistiment, Renúncia i Desert són una adjudicació que no va existir", () => {
    expect(isNotAwardedResultat("Desistiment")).toBe(true);
    expect(isNotAwardedResultat("Renúncia")).toBe(true);
    expect(isNotAwardedResultat("Desert")).toBe(true);
  });

  it("el resultat buit (anunci retirat) i qualsevol altre valor no ho són", () => {
    expect(isNotAwardedResultat("")).toBe(false);
    expect(isNotAwardedResultat(undefined)).toBe(false);
    expect(isNotAwardedResultat(null)).toBe(false);
    expect(isNotAwardedResultat("Adjudicació")).toBe(false);
    expect(isNotAwardedResultat("desert")).toBe(false);
  });
});

// ── normalizeAnnulmentLine ────────────────────────────────────────────────

describe("normalizeAnnulmentLine", () => {
  it("normalitza una línia simple: camps retallats, dates en format ISO, resultat buit", () => {
    const line = normalizeAnnulmentLine(RAW_PLAIN)!;
    expect(line).toMatchObject({
      url: "https://example.invalid/detall-publicacio/aaa/111",
      codiExpedient: "EXP-0001",
      organ: "Organ Sintetic A",
      adjudicatariId: "X0000001Z",
      adjudicatari: "Proveidor Sintetic SL",
      amount: 885,
      awardDate: "2024-01-02",
      resultat: "",
      agregada: "SÍ",
      annulDate: "2025-12-04",
    });
    expect(line.lineKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("conserva el resultat oficial", () => {
    expect(normalizeAnnulmentLine(RAW_WITHDRAWN)!.resultat).toBe("Desistiment");
  });

  it("els imports `||||` queden amb amount null, però la línia es conserva", () => {
    const line = normalizeAnnulmentLine(RAW_MULTI_SUPPLIER)!;
    expect(line.amount).toBeNull();
    expect(line.amountRaw).toBe("||||||||");
    expect(line.codiExpedient).toBe("EXP-0003");
  });

  it("una línia sense data d'adjudicació o d'anul·lació les deixa a null", () => {
    const line = normalizeAnnulmentLine({
      ...RAW_PLAIN,
      data_adjudicacio_contracte: undefined,
      data_publicacio_anul: undefined,
    })!;
    expect(line.awardDate).toBeNull();
    expect(line.annulDate).toBeNull();
  });

  it("descarta les files sense enllaç de publicació o sense codi d'expedient", () => {
    expect(normalizeAnnulmentLine({ ...RAW_PLAIN, enllac_publicacio: undefined })).toBeNull();
    expect(normalizeAnnulmentLine({ ...RAW_PLAIN, enllac_publicacio: { url: "  " } })).toBeNull();
    expect(normalizeAnnulmentLine({ ...RAW_PLAIN, codi_expedient: "" })).toBeNull();
    expect(normalizeAnnulmentLine({ ...RAW_PLAIN, codi_expedient: undefined })).toBeNull();
  });

  it("la clau és estable i depèn de cada camp de la línia", () => {
    const a = normalizeAnnulmentLine(RAW_PLAIN)!;
    const b = normalizeAnnulmentLine({ ...RAW_PLAIN })!;
    expect(a.lineKey).toBe(b.lineKey);
    const variants: Array<Partial<typeof RAW_PLAIN & { resultat: string }>> = [
      { resultat: "Renúncia" },
      { import_adjudicacio_sense: "886" },
      { codi_expedient: "EXP-0009" },
      { data_publicacio_anul: "2025-12-05T00:00:00.000" },
      { identificacio_adjudicatari: "X0000002Z" },
      { enllac_publicacio: { url: "https://example.invalid/detall-publicacio/aaa/222" } },
    ];
    for (const v of variants) {
      expect(normalizeAnnulmentLine({ ...RAW_PLAIN, ...v })!.lineKey).not.toBe(a.lineKey);
    }
  });

  it("la clau no s'afecta per espais sobrants", () => {
    const padded = normalizeAnnulmentLine({ ...RAW_PLAIN, nom_organ: "  Organ Sintetic A  " })!;
    expect(padded.lineKey).toBe(normalizeAnnulmentLine(RAW_PLAIN)!.lineKey);
  });
});

// ── URL de pàgina ─────────────────────────────────────────────────────────

describe("annulmentPageUrl", () => {
  it("demana només les anul·lacions amb import, ordenades de manera estable, pàgines de 1000", () => {
    const url = new URL(annulmentPageUrl(2000));
    expect(url.origin + url.pathname).toBe("https://analisi.transparenciacatalunya.cat/resource/ybgg-dgi6.json");
    expect(url.searchParams.get("$limit")).toBe(String(ANNULMENT_PAGE_SIZE));
    expect(ANNULMENT_PAGE_SIZE).toBe(1000);
    expect(url.searchParams.get("$offset")).toBe("2000");
    expect(url.searchParams.get("$where")).toContain("fase_publicacio = 'Anul·lació'");
    expect(url.searchParams.get("$where")).toContain("import_adjudicacio_sense is not null");
    expect(url.searchParams.get("$where")).toContain("import_adjudicacio_amb_iva is not null");
    const order = url.searchParams.get("$order")!;
    expect(order.startsWith("codi_expedient,data_publicacio_anul,enllac_publicacio")).toBe(true);
    // El desempat per :id fa que la paginació no salti ni repeteixi files.
    expect(order.endsWith(",:id")).toBe(true);
    expect(url.searchParams.get("$select")).toContain("resultat");
    expect(url.searchParams.get("$select")).toContain(":id");
  });
});

// ── fetchJsonWithRetry ────────────────────────────────────────────────────

describe("fetchJsonWithRetry", () => {
  it("reintenta els 500 i 503 amb espera creixent i acaba tornant el cos", async () => {
    const { fetchFn, calls } = scripted([response(503, null), response(500, null), response(200, [{ a: 1 }])]);
    const { waits, sleep } = recorderSleep();
    const body = await fetchJsonWithRetry("https://example.invalid/x", { fetchFn, sleep }, { maxAttempts: 5, baseDelayMs: 100 });
    expect(body).toEqual([{ a: 1 }]);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([100, 200]);
  });

  it("reintenta els 429 i respecta Retry-After quan és més llarg que l'espera calculada", async () => {
    const { fetchFn } = scripted([response(429, null, { "retry-after": "7" }), response(200, [])]);
    const { waits, sleep } = recorderSleep();
    await fetchJsonWithRetry("https://example.invalid/x", { fetchFn, sleep }, { maxAttempts: 3, baseDelayMs: 100 });
    expect(waits).toEqual([7000]);
  });

  it("reintenta els errors de xarxa", async () => {
    let n = 0;
    const fetchFn = async () => {
      n++;
      if (n < 3) throw new Error("socket hang up");
      return response(200, ["ok"]);
    };
    const { waits, sleep } = recorderSleep();
    const body = await fetchJsonWithRetry("https://example.invalid/x", { fetchFn, sleep }, { maxAttempts: 4, baseDelayMs: 50 });
    expect(body).toEqual(["ok"]);
    expect(waits).toEqual([50, 100]);
  });

  it("no reintenta un 4xx que no és 429 i llança", async () => {
    const { fetchFn, calls } = scripted([response(400, null)]);
    const { sleep } = recorderSleep();
    await expect(
      fetchJsonWithRetry("https://example.invalid/x", { fetchFn, sleep }, { maxAttempts: 5, baseDelayMs: 10 })
    ).rejects.toThrow(/400/);
    expect(calls).toHaveLength(1);
  });

  it("es rendeix després de maxAttempts intents", async () => {
    const { fetchFn, calls } = scripted([response(503, null)]);
    const { sleep } = recorderSleep();
    await expect(
      fetchJsonWithRetry("https://example.invalid/x", { fetchFn, sleep }, { maxAttempts: 3, baseDelayMs: 10 })
    ).rejects.toThrow(/503/);
    expect(calls).toHaveLength(3);
  });
});

// ── fetchAnnulmentLines ───────────────────────────────────────────────────

function rowsOf(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    ...RAW_PLAIN,
    codi_expedient: `EXP-${String(offset + i).padStart(5, "0")}`,
  }));
}

describe("fetchAnnulmentLines", () => {
  it("pagina fins a una pàgina curta i normalitza totes les línies", async () => {
    const { fetchFn, calls } = scripted([
      response(200, rowsOf(1000, 0)),
      response(200, rowsOf(1000, 1000)),
      response(200, rowsOf(37, 2000)),
    ]);
    const { sleep } = recorderSleep();
    const out = await fetchAnnulmentLines({ fetchFn, sleep });
    expect(out.lines).toHaveLength(2037);
    expect(out.pages).toBe(3);
    expect(out.fromCache).toBe(0);
    expect(calls.map((u) => new URL(u).searchParams.get("$offset"))).toEqual(["0", "1000", "2000"]);
  });

  it("amb una pàgina buida al final també s'atura", async () => {
    const { fetchFn, calls } = scripted([response(200, rowsOf(1000)), response(200, [])]);
    const { sleep } = recorderSleep();
    const out = await fetchAnnulmentLines({ fetchFn, sleep });
    expect(out.lines).toHaveLength(1000);
    expect(calls).toHaveLength(2);
  });

  it("comptabilitza les files descartades i les línies idèntiques repetides, i no les torna dues vegades", async () => {
    const page = [RAW_PLAIN, RAW_PLAIN, { ...RAW_PLAIN, enllac_publicacio: undefined }, RAW_WITHDRAWN];
    const { fetchFn } = scripted([response(200, page)]);
    const { sleep } = recorderSleep();
    const out = await fetchAnnulmentLines({ fetchFn, sleep });
    expect(out.lines).toHaveLength(2);
    expect(out.skipped).toBe(1);
    expect(out.repeatedLines).toBe(1);
  });

  it("reintenta una pàgina que dóna 503 sense perdre cap línia", async () => {
    const { fetchFn } = scripted([response(503, null), response(200, rowsOf(5))]);
    const { waits, sleep } = recorderSleep();
    const out = await fetchAnnulmentLines({ fetchFn, sleep }, { baseDelayMs: 10 });
    expect(out.lines).toHaveLength(5);
    expect(out.retries).toBe(1);
    expect(waits).toEqual([10]);
  });

  it("la memòria cau evita tornar a baixar les pàgines", async () => {
    const store = new Map<string, unknown[]>();
    const cache = {
      read: (key: string) => store.get(key) ?? null,
      write: (key: string, rows: unknown[]) => void store.set(key, rows),
    };
    const first = scripted([response(200, rowsOf(1000)), response(200, rowsOf(3, 1000))]);
    const { sleep } = recorderSleep();
    const a = await fetchAnnulmentLines({ fetchFn: first.fetchFn, sleep, cache });
    expect(first.calls).toHaveLength(2);
    expect(store.size).toBe(2);

    const second = scripted([response(500, null)]);
    const b = await fetchAnnulmentLines({ fetchFn: second.fetchFn, sleep, cache });
    expect(second.calls).toHaveLength(0);
    expect(b.fromCache).toBe(2);
    expect(b.lines.map((l) => l.lineKey)).toEqual(a.lines.map((l) => l.lineKey));
  });
});

// ── buildLinesUpsertSql / entityRecomputeSql ──────────────────────────────

describe("buildLinesUpsertSql", () => {
  const lines = [normalizeAnnulmentLine(RAW_PLAIN)!, normalizeAnnulmentLine(RAW_WITHDRAWN)!];

  it("genera un INSERT per lots amb jsonb_to_recordset i sense actualitzar les línies ja conegudes", () => {
    const sql = buildLinesUpsertSql(lines, 1);
    expect(sql).toHaveLength(2);
    for (const stmt of sql) {
      expect(stmt).toMatch(/INSERT INTO public\.contract_official_annulments/);
      expect(stmt).toMatch(/jsonb_to_recordset/);
      expect(stmt).toMatch(/ON CONFLICT \(line_key\) DO NOTHING/);
    }
  });

  it("el JSON va entre cometes de dòlar i l'etiqueta no apareix dins de les dades", () => {
    const tricky: AnnulmentLine = { ...lines[0], adjudicatari: "Nom amb $q$ i cometes ' dobles \" i \\ barra" };
    const [stmt] = buildLinesUpsertSql([tricky], 10);
    const tag = stmt.match(/\$(\w+)\$/)![0];
    const inner = stmt.slice(stmt.indexOf(tag) + tag.length, stmt.lastIndexOf(tag));
    expect(inner).not.toContain(tag);
    expect(JSON.parse(inner)[0].adjudicatari).toBe(tricky.adjudicatari);
  });

  it("amount null i dates null es transmeten com a null", () => {
    const multi = normalizeAnnulmentLine({ ...RAW_MULTI_SUPPLIER, data_adjudicacio_contracte: undefined })!;
    const [stmt] = buildLinesUpsertSql([multi], 10);
    const tag = stmt.match(/\$(\w+)\$/)![0];
    const inner = JSON.parse(stmt.slice(stmt.indexOf(tag) + tag.length, stmt.lastIndexOf(tag)));
    expect(inner[0].amount).toBeNull();
    expect(inner[0].award_date).toBeNull();
  });
});

describe("dollarQuoted", () => {
  it("embolcalla el text amb una etiqueta que no hi apareix i el text queda intacte", () => {
    const text = `{"a": "$x$ i $ann_1234abcd$ i ' i \\ barra"}`;
    const quoted = dollarQuoted(text);
    const tag = quoted.match(/^\$(\w+)\$/)![0];
    expect(quoted.endsWith(tag)).toBe(true);
    expect(quoted.slice(tag.length, quoted.length - tag.length)).toBe(text);
    expect(text).not.toContain(tag);
  });
});

describe("entityRecomputeSql", () => {
  it("reprodueix els passos 4, 5 i 6 d'aggregate-stats només per a les entitats indicades", () => {
    const sql = entityRecomputeSql("ids");
    expect(sql).toMatch(/total_contracts = 0, total_contract_amount = 0/);
    expect(sql).toMatch(/SUM\(amount\) AS total_contract_amount/);
    expect(sql).toMatch(/total_public_funds = COALESCE\(total_amount, 0\) \+ COALESCE\(total_contract_amount, 0\)/);
    expect(sql).toMatch(/UPDATE public\.entity_yearly_stats/);
    // Cada sentència queda restringida a les entitats.
    expect(sql.match(/ANY\(ids\)/g)!.length).toBeGreaterThanOrEqual(6);
    expect(sql).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bREFRESH\b/i);
  });
});

// ── Regla 4: comprovació d'una publicació vàlida ──────────────────────────

const CANDIDATE: OfficialCheckCandidate = {
  organ: "Organ Sintetic A",
  codiExpedient: "EXP-0001",
  keyCif: "X0000001Z",
  keySlug: "",
  lotNumber: "1",
  lineUrl: "https://example.invalid/detall-publicacio/aaa/111",
  adjudicatariId: "X0000001Z",
  adjudicatari: "Proveidor Sintetic SL",
  amount: 885,
  awardDate: "2024-01-02",
};

const VALID: SodaValidRecord = {
  id: ":row-1",
  organ: "Organ Sintetic A",
  codiExpedient: "EXP-9999",
  adjudicatariId: "X0000001Z",
  adjudicatari: "Proveidor Sintetic SL",
  amount: 885,
  awardDate: "2024-01-02",
  fase: "Publicació agregada de contractes",
  resultat: "",
};

describe("matchValidRecord", () => {
  it("troba el registre no anul·lat de la mateixa adjudicació amb un altre codi", () => {
    expect(matchValidRecord(CANDIDATE, [VALID])).toEqual(VALID);
  });

  it("també el troba amb el mateix codi (cap restricció de codi)", () => {
    const same = { ...VALID, codiExpedient: "EXP-0001" };
    expect(matchValidRecord(CANDIDATE, [same])).toEqual(same);
  });

  it("un registre d'una altra fase que no és d'anul·lació compta; un d'anul·lació no", () => {
    expect(matchValidRecord(CANDIDATE, [{ ...VALID, fase: "Adjudicació" }])).not.toBeNull();
    expect(matchValidRecord(CANDIDATE, [{ ...VALID, fase: "Anul·lació" }])).toBeNull();
  });

  it("un registre amb resultat Desert, Desistiment o Renúncia no és una adjudicació vàlida", () => {
    for (const resultat of ["Desert", "Desistiment", "Renúncia"]) {
      expect(matchValidRecord(CANDIDATE, [{ ...VALID, resultat }])).toBeNull();
    }
  });

  it("exigeix el mateix òrgan, el mateix import i la mateixa data d'adjudicació", () => {
    expect(matchValidRecord(CANDIDATE, [{ ...VALID, organ: "Organ Sintetic B" }])).toBeNull();
    expect(matchValidRecord(CANDIDATE, [{ ...VALID, amount: 886 }])).toBeNull();
    expect(matchValidRecord(CANDIDATE, [{ ...VALID, amount: null }])).toBeNull();
    expect(matchValidRecord(CANDIDATE, [{ ...VALID, awardDate: "2024-01-03" }])).toBeNull();
    expect(matchValidRecord(CANDIDATE, [{ ...VALID, awardDate: null }])).toBeNull();
  });

  it("l'import es compara al cèntim", () => {
    expect(matchValidRecord(CANDIDATE, [{ ...VALID, amount: 885.004 }])).not.toBeNull();
    expect(matchValidRecord(CANDIDATE, [{ ...VALID, amount: 885.02 }])).toBeNull();
  });

  it("amb identificador sense emmascarar, un identificador diferent no coincideix encara que el nom sigui igual", () => {
    expect(matchValidRecord(CANDIDATE, [{ ...VALID, adjudicatariId: "X0000002Z" }])).toBeNull();
    expect(matchValidRecord(CANDIDATE, [{ ...VALID, adjudicatariId: " x0000001z " }])).not.toBeNull();
  });

  it("amb identificador emmascarat compara el nom, sense majúscules ni accents ni puntuació", () => {
    const masked: OfficialCheckCandidate = { ...CANDIDATE, adjudicatariId: "***5738*****", adjudicatari: "María Núñez, S.L." };
    const rec: SodaValidRecord = { ...VALID, adjudicatariId: "***9999*****", adjudicatari: "MARIA NUNEZ SL" };
    expect(matchValidRecord(masked, [rec])).not.toBeNull();
    expect(matchValidRecord(masked, [{ ...rec, adjudicatari: "Altra Persona" }])).toBeNull();
  });

  it("un candidat sense data d'adjudicació o sense import no es pot demostrar: cap coincidència", () => {
    expect(matchValidRecord({ ...CANDIDATE, awardDate: null }, [VALID])).toBeNull();
    expect(matchValidRecord({ ...CANDIDATE, amount: null }, [VALID])).toBeNull();
  });
});

describe("planOfficialChecks", () => {
  it("agrupa els candidats per òrgan i separa els identificadors dels noms emmascarats", () => {
    const candidates: OfficialCheckCandidate[] = [
      CANDIDATE,
      { ...CANDIDATE, codiExpedient: "EXP-0002", adjudicatariId: "X0000003Z", adjudicatari: "Altre SL" },
      { ...CANDIDATE, codiExpedient: "EXP-0003", adjudicatariId: "***1111*****", adjudicatari: "Persona Sintetica" },
      { ...CANDIDATE, organ: "Organ Sintetic B", codiExpedient: "EXP-0004" },
    ];
    const plan = planOfficialChecks(candidates, { batchSize: 10 });
    expect(plan.map((p) => p.organ).sort()).toEqual(["Organ Sintetic A", "Organ Sintetic B"]);
    const a = plan.find((p) => p.organ === "Organ Sintetic A")!;
    expect(a.ids.sort()).toEqual(["X0000001Z", "X0000003Z"]);
    expect(a.names).toEqual(["Persona Sintetica"]);
    expect(a.candidates).toHaveLength(3);
  });

  it("parteix un òrgan en diversos lots", () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      ...CANDIDATE,
      codiExpedient: `EXP-${i}`,
      adjudicatariId: `X000000${i}Z`,
    }));
    const plan = planOfficialChecks(candidates, { batchSize: 2 });
    expect(plan).toHaveLength(3);
    expect(plan.reduce((n, p) => n + p.candidates.length, 0)).toBe(5);
  });

  it("la consulta exclou les anul·lacions i porta l'òrgan i els identificadors escapats", () => {
    const plan = planOfficialChecks([{ ...CANDIDATE, organ: "Organ d'Aquí" }], { batchSize: 10 });
    const url = new URL(plan[0].url);
    const where = url.searchParams.get("$where")!;
    expect(where).toContain("nom_organ = 'Organ d''Aquí'");
    expect(where).toContain("fase_publicacio != 'Anul·lació'");
    expect(where).toContain("identificacio_adjudicatari in ('X0000001Z')");
  });
});

describe("runOfficialChecks", () => {
  it("tria cada candidat contra els registres de la seva consulta, sense passar de 2 consultes alhora", async () => {
    let active = 0;
    let peak = 0;
    const fetchFn: FakeFetch = async (url) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      const organ = new URL(url).searchParams.get("$where")!.includes("Organ Sintetic B") ? "Organ Sintetic B" : "Organ Sintetic A";
      const rows =
        organ === "Organ Sintetic A"
          ? [
              {
                ":id": "row-a",
                nom_organ: "Organ Sintetic A",
                codi_expedient: "EXP-7777",
                identificacio_adjudicatari: "X0000001Z",
                denominacio_adjudicatari: "Proveidor Sintetic SL",
                import_adjudicacio_sense: "885",
                data_adjudicacio_contracte: "2024-01-02T00:00:00.000",
                fase_publicacio: "Adjudicació",
              },
            ]
          : [];
      return response(200, rows);
    };
    const candidates: OfficialCheckCandidate[] = [
      CANDIDATE,
      { ...CANDIDATE, organ: "Organ Sintetic B", codiExpedient: "EXP-0004" },
      { ...CANDIDATE, organ: "Organ Sintetic C", codiExpedient: "EXP-0005" },
      { ...CANDIDATE, organ: "Organ Sintetic D", codiExpedient: "EXP-0006" },
    ];
    const { sleep } = recorderSleep();
    const out = await runOfficialChecks(candidates, { fetchFn, sleep }, { concurrency: 2, batchSize: 10 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(out).toHaveLength(4);
    const first = out.find((r) => r.codi_expedient === "EXP-0001")!;
    expect(first).toMatchObject({
      found: true,
      record_id: "row-a",
      organ: "Organ Sintetic A",
      cif: "X0000001Z",
      entity_slug: "",
      lot_number: "1",
      line_url: CANDIDATE.lineUrl,
    });
    expect(out.filter((r) => !r.found)).toHaveLength(3);
  });

  it("un candidat que no es pot identificar del tot (sense data d'adjudicació) no rep resposta: queda pendent", async () => {
    const fetchFn: FakeFetch = async () => response(200, []);
    const { sleep } = recorderSleep();
    const out = await runOfficialChecks(
      [{ ...CANDIDATE, awardDate: null }, { ...CANDIDATE, codiExpedient: "EXP-0002", adjudicatariId: "", adjudicatari: "" }],
      { fetchFn, sleep }
    );
    expect(out).toEqual([]);
  });

  it("un candidat amb el mateix òrgan, proveïdor i import però una altra data d'adjudicació no té registre vàlid, però consta com a data diferent", async () => {
    const fetchFn: FakeFetch = async () =>
      response(200, [
        {
          ":id": "row-b",
          nom_organ: "Organ Sintetic A",
          codi_expedient: "EXP-8888",
          identificacio_adjudicatari: "X0000001Z",
          denominacio_adjudicatari: "Proveidor Sintetic SL",
          import_adjudicacio_sense: "885",
          data_adjudicacio_contracte: "2024-02-02T00:00:00.000",
          fase_publicacio: "Adjudicació",
        },
      ]);
    const { sleep } = recorderSleep();
    const [answer] = await runOfficialChecks([CANDIDATE], { fetchFn, sleep });
    expect(answer.found).toBe(false);
    expect(answer.near_miss).toBe(true);
  });

  it("el payload per a la funció de decisió porta la clau natural, l'enllaç de l'anul·lació i la resposta, sense el diagnòstic", () => {
    const payload = buildOfficialCheckPayload([
      { organ: "O", codi_expedient: "C", cif: "", entity_slug: "slug", lot_number: "", line_url: "https://example.invalid/a", found: false, near_miss: true },
      { organ: "O", codi_expedient: "D", cif: "X0000001Z", entity_slug: "", lot_number: "1", line_url: "https://example.invalid/b", found: true, record_id: "r-1" },
    ]);
    expect(JSON.parse(payload)).toEqual([
      { organ: "O", codi_expedient: "C", cif: "", entity_slug: "slug", lot_number: "", line_url: "https://example.invalid/a", found: false },
      { organ: "O", codi_expedient: "D", cif: "X0000001Z", entity_slug: "", lot_number: "1", line_url: "https://example.invalid/b", found: true, record_id: "r-1" },
    ]);
  });
});

// ── Pipeline: les dues crides a apply_contract_annulments ─────────────────

describe("connexió amb la càrrega i l'agregació de contractes", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("sync-contractes.ts crida apply_contract_annulments abans de les neteges i després de la detecció d'àlies", () => {
    const src = read("../../src/connectors/sync-contractes.ts");
    const firstApply = src.indexOf("apply_contract_annulments");
    const lastApply = src.lastIndexOf("apply_contract_annulments");
    const dedup = src.indexOf("Dedup: marking alternative-expedient duplicates");
    const alias = src.indexOf("detect_contract_expedient_aliases()");
    expect(firstApply).toBeGreaterThan(-1);
    expect(firstApply).toBeLessThan(dedup);
    expect(lastApply).toBeGreaterThan(alias);
  });

  it("aggregate-stats.ts crida apply_contract_annulments abans de les neteges i després de la detecció d'àlies", () => {
    const src = read("../../src/pipeline/aggregate-stats.ts");
    const firstApply = src.indexOf("apply_contract_annulments");
    const lastApply = src.lastIndexOf("apply_contract_annulments");
    const sweep = src.indexOf('runSQL("Alt-expedient dedup sweep"');
    const alias = src.indexOf("detect_contract_expedient_aliases()");
    const entityBackfill = src.indexOf("Backfill contract entity_id (CIF)");
    expect(firstApply).toBeGreaterThan(-1);
    expect(firstApply).toBeLessThan(sweep);
    expect(lastApply).toBeGreaterThan(alias);
    expect(lastApply).toBeLessThan(entityBackfill);
  });
});
