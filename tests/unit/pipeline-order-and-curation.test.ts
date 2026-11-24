import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isCompanyCif } from "../../src/lib/raisc-helpers";

const root = resolve(__dirname, "..", "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

/**
 * The README documents the production refresh order; the repository has to
 * reproduce production's figures, so the order is pinned here.
 */
describe("documented pipeline order (production refresh order)", () => {
  const readme = read("README.md");
  const start = readme.indexOf("# 3. Ordre del procés de producció");
  const block = readme.slice(start, readme.indexOf("```", start));
  const at = (needle: string) => {
    const i = block.indexOf(needle);
    expect(i, needle).toBeGreaterThanOrEqual(0);
    return i;
  };

  it("loads, consolidates, reconciles stubs and curated aliases, aggregates, scores, then runs the network", () => {
    const order = [
      "sync-raisc.ts",
      "sync-contractes.ts",
      "sync-contract-annulments.ts",
      "consolidate-entities.ts",
      "020-reconcile-entity-stubs.sql",
      "030-reconcile-curated-aliases.sql",
      "aggregate-stats.ts",
      "calculate-scores-sql.ts",
      "analyze-contract-network.ts",
    ].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("runs both entity-resolution SQL steps inside one transaction", () => {
    expect(block).toContain("020-reconcile-entity-stubs.sql --single-transaction");
    expect(block).toContain("030-reconcile-curated-aliases.sql --single-transaction");
  });
});

/**
 * Hand-made lists are published because verification needs them. None of
 * their rows may name a natural person: every identifier is an organisation's.
 */
describe("hand-checked lists", () => {
  it("curated entity aliases: 14 rows, each an organisation CIF and its own name variants", () => {
    const sql = read("sql/pipeline/030-reconcile-curated-aliases.sql");
    const rows = [...sql.matchAll(/^\s*\('([A-Z0-9]{9})',\s*'((?:[^']|'')*)',\s*(NULL|'[^']*')\)/gm)];
    expect(rows).toHaveLength(14);
    for (const [, cif] of rows) {
      expect(isCompanyCif(cif), cif).toBe(true);
      expect(cif, cif).toMatch(/^[GPQ]/);
    }
  });

  it("curated expedient pairs: 4 rows, all of public contracting bodies", () => {
    const sql = read("sql/curation/010-contract-expedient-aliases.sql");
    const organs = [...sql.matchAll(/^\s*\('([^']+)',\s*'[^']+',\s*'[^']+',/gm)].map((m) => m[1]);
    expect(organs).toEqual([
      "Ajuntament de Barcelona",
      "Ajuntament de Lleida",
      "CALAFELL EMPRESA MUNICIPAL DE SERVEIS, SA",
      "Ajuntament de Tarragona",
    ]);
  });

  it("budget line → entity mapping: 184 rows, all pointing at entity slugs", () => {
    const src = read("src/connectors/sync-pressupostos.ts");
    const start = src.indexOf("const ENTITY_MAPPING");
    const map = src.slice(start, src.indexOf("]);", start));
    const rows = [...map.matchAll(/\[\s*"((?:[^"\\]|\\.)*)",\s*"([^"]*)"\s*\]/g)];
    expect(rows).toHaveLength(184);
    for (const [, , slug] of rows) expect(slug).toMatch(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/);
  });
});
