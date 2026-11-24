import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../../src/lib/db";
import { remapSlugsToExistingCifs } from "../../src/lib/entity-resolver";
import {
  RETRY_ATTEMPTS_DEFAULT,
  insertGrantsBatch,
  mapToGrant,
  upsertEntitiesBatch,
  type MappedEntity,
  type RaiscRow,
} from "../../src/lib/raisc-helpers";

vi.mock("../../src/lib/entity-resolver", () => ({
  remapSlugsToExistingCifs: vi.fn(async () => 0),
}));

interface FakeDbOptions {
  /** Error message the database returns for the bulk INSERT ... ON CONFLICT (cif). */
  upsertError?: string;
  /** Error thrown by every statement (a network cut). */
  throwAll?: Error;
  /** Rows returned by SELECTs. */
  selectRows?: Record<string, unknown>[];
}

function entity(overrides: Partial<MappedEntity> = {}): MappedEntity {
  return {
    slug: "ENTITAT-TEST",
    name: "Entitat Test",
    cif: "G12345678",
    comarca_code: null,
    province_code: null,
    comarca: null,
    beneficiary_type: null,
    ...overrides,
  };
}

function entityMap(...entities: MappedEntity[]): Map<string, MappedEntity> {
  return new Map(entities.map((e) => [e.slug, e]));
}

/** A database that records every statement and fails as configured. */
function fakeDb(options: FakeDbOptions = {}) {
  const calls = {
    inserts: [] as Array<{ sql: string; params: unknown[] }>,
    updates: [] as Array<{ sql: string; params: unknown[] }>,
    selects: [] as Array<{ sql: string; params: unknown[] }>,
  };

  const db: Queryable = {
    async query(text: string, values: unknown[] = []) {
      const sql = text.trim();
      if (sql.startsWith("INSERT")) {
        calls.inserts.push({ sql, params: values });
        if (options.throwAll) throw options.throwAll;
        if (options.upsertError && sql.includes("ON CONFLICT (cif)")) {
          throw new Error(options.upsertError);
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("UPDATE")) {
        calls.updates.push({ sql, params: values });
        if (options.throwAll) throw options.throwAll;
        return { rows: [], rowCount: 1 };
      }
      calls.selects.push({ sql, params: values });
      if (options.throwAll) throw options.throwAll;
      return { rows: (options.selectRows ?? []) as never[], rowCount: options.selectRows?.length ?? 0 };
    },
  };

  return { db, calls };
}

describe("RAISC entity upsert guard: non-inferable CIF ON CONFLICT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(remapSlugsToExistingCifs).mockResolvedValue(0);
  });

  it("throws on the ON CONFLICT inference error and includes error text plus batch size", async () => {
    const { db, calls } = fakeDb({
      upsertError: "there is no unique or exclusion constraint matching the ON CONFLICT specification",
    });

    await expect(
      upsertEntitiesBatch(
        db,
        entityMap(
          entity(),
          entity({ slug: "ENTITAT-TEST-2", name: "Entitat Test 2", cif: "G87654321" })
        )
      )
    ).rejects.toThrow(
      /Entity upsert with CIF failed for batch of 2 rows: there is no unique or exclusion constraint matching the ON CONFLICT specification/
    );
    expect(calls.inserts).toHaveLength(1);
    expect(calls.updates).toHaveLength(0);
  });

  it("does not throw on entities_slug_key and falls back to per-row updates", async () => {
    const { db, calls } = fakeDb({
      upsertError: 'duplicate key value violates unique constraint "entities_slug_key"',
    });

    await expect(upsertEntitiesBatch(db, entityMap(entity()))).resolves.toBe(1);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].params.at(-1)).toBe("G12345678");
  });

  it("does not throw on generic duplicate-key errors and falls back to per-row updates", async () => {
    const { db, calls } = fakeDb({
      upsertError: "duplicate key value violates unique constraint",
    });

    await expect(upsertEntitiesBatch(db, entityMap(entity()))).resolves.toBe(1);
    expect(calls.updates).toHaveLength(1);
  });

  it("throws network errors after exhausting retries", async () => {
    // Without a shorter wait, exhausting the 7 attempts would cost 61 real
    // seconds (1+2+4+8+16+30). The curve itself is tested in raisc-helpers.test.ts.
    vi.stubEnv("RAISC_RETRY_BASE_DELAY_MS", "1");
    const { db, calls } = fakeDb({ throwAll: new Error("fetch failed") });

    await expect(upsertEntitiesBatch(db, entityMap(entity()))).rejects.toThrow(
      /Entity upsert with CIF failed for batch of 1 rows: fetch failed/
    );
    expect(calls.inserts).toHaveLength(RETRY_ATTEMPTS_DEFAULT);
    expect(calls.updates).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("retries the driver's own socket errors too", async () => {
    vi.stubEnv("RAISC_RETRY_BASE_DELAY_MS", "1");
    const { db, calls } = fakeDb({ throwAll: new Error("Connection terminated unexpectedly") });

    await expect(upsertEntitiesBatch(db, entityMap(entity()))).rejects.toThrow(/Connection terminated/);
    expect(calls.inserts).toHaveLength(RETRY_ATTEMPTS_DEFAULT);
    vi.unstubAllEnvs();
  });

  it("does not throw and does not call the per-row path when the bulk upsert succeeds", async () => {
    const { db, calls } = fakeDb();

    await expect(upsertEntitiesBatch(db, entityMap(entity()))).resolves.toBe(1);
    expect(calls.inserts).toHaveLength(1);
    expect(calls.updates).toHaveLength(0);
  });

  it("writes CIF entities with ON CONFLICT (cif) and keeps stored geography when the row has none", async () => {
    const { db, calls } = fakeDb();
    await upsertEntitiesBatch(db, entityMap(entity({ comarca_code: "13", province_code: "08" })));

    const sql = calls.inserts[0].sql;
    expect(sql).toContain("ON CONFLICT (cif) DO UPDATE SET");
    expect(sql).toContain("comarca_code = COALESCE(EXCLUDED.comarca_code, entities.comarca_code)");
    expect(calls.inserts[0].params).toEqual([
      "ENTITAT-TEST", "Entitat Test", "G12345678", "raisc", "13", "08", null, null,
    ]);
  });

  it("creates entities without CIF only when the slug is free, and marks non-publishable buckets as anonymized", async () => {
    const { db, calls } = fakeDb();
    await upsertEntitiesBatch(
      db,
      entityMap(entity({ slug: "BENEF-NO-PUBLICABLE-DEPARTAMENT-X", name: "Benef. no publicable (Departament X)", cif: null }))
    );

    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0].sql).toContain("ON CONFLICT (slug) DO NOTHING");
    expect(calls.inserts[0].params.slice(0, 3)).toEqual([
      "BENEF-NO-PUBLICABLE-DEPARTAMENT-X",
      "Benef. no publicable (Departament X)",
      true,
    ]);
  });
});

describe("RAISC grant insert", () => {
  const row = {
    clau: "K-001",
    ra_social_del_beneficiari: "FUNDACIO EXEMPLE",
    cif_beneficiari: "G12345678",
    tipus_de_beneficiaris_codi: "JSA",
    import_subvenci_pr_stec_ajut: "10000",
    data_concessi: "2021-06-15",
    departament_o_entitat_local_d_adscripci_: "Departament de Cultura",
    finalitat_rais: "CULTURA",
    ajut_d_estat: "No",
  } as RaiscRow;

  it("resolves entity_id by CIF, uses the canonical slug and never duplicates a raisc_clau", async () => {
    const { db, calls } = fakeDb({ selectRows: [{ id: "e-1", slug: "FUNDACIO-EXEMPLE-CANON", cif: "G12345678" }] });
    const grant = mapToGrant(row, "FUNDACIO-EXEMPLE")!;

    await expect(insertGrantsBatch(db, [grant])).resolves.toEqual({ processed: 1, skipped: 0 });

    expect(calls.selects[0].sql).toContain("WHERE cif = ANY($1::text[])");
    const insert = calls.inserts[0];
    expect(insert.sql).toContain("INSERT INTO grants (entity_id, entity_slug, cif, amount");
    expect(insert.sql).toContain("ON CONFLICT (raisc_clau) DO NOTHING");
    expect(insert.params.slice(0, 4)).toEqual(["e-1", "FUNDACIO-EXEMPLE-CANON", "G12345678", 10000]);
    expect(insert.params).toContain("K-001");
    expect(insert.params).toContain("raisc_concessions");
  });
});
