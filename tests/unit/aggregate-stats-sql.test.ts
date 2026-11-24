import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The aggregation is one file of inline SQL, so its invariants are asserted
 * against the statements themselves. Two of them, both measured against the
 * database:
 *
 *  - FILTER PARITY. Step 1 excludes ICF credits from an entity's grant totals;
 *    step 2 did not, so the yearly series counted ~935 M€ of loans as grants
 *    and came out above the matview it is supposed to decompose.
 *
 *  - ZERO-OUT PARITY. When every grant of an (entity, year) is superseded, the
 *    yearly row has to fall to zero. Contracts had that sweep since step 6b;
 *    grants did not, so ~344 M€ of withdrawn money stayed on the chart.
 *
 * An anti-join is only as good as its predicate: whatever the upsert counts,
 * the zero-out has to look for, or a row will be cleared (or spared) on a
 * different rule than the one that filled it.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../src/pipeline/aggregate-stats.ts", import.meta.url)),
  "utf8"
);

/** The SQL of one `runSQL("<label>", ...)` call. */
function sqlFor(label: string): string {
  const match = new RegExp(
    `runSQL\\(\\s*"${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",\\s*\`([\\s\\S]*?)\`\\s*\\)`
  ).exec(SOURCE);

  expect(match, `no runSQL step labelled "${label}"`).not.toBeNull();
  return match![1]!;
}

const GRANT_AGGREGATION_STEPS = [
  "Update entity grant totals",
  "Zero out entities with no grants",
  "Upsert yearly grant stats",
  "Zero stale yearly grant stats",
];

describe("aggregate-stats — grants exclude ICF credits everywhere", () => {
  it("keeps every grant aggregation on the same filter", () => {
    for (const label of GRANT_AGGREGATION_STEPS) {
      expect(sqlFor(label), label).toContain("is_credit IS NOT TRUE");
    }
  });

  it("still aggregates credits on their own, and only there", () => {
    for (const label of ["Update entity credit totals", "Zero out entities with no credits"]) {
      expect(sqlFor(label), label).toContain("is_credit = true");
    }
    for (const label of GRANT_AGGREGATION_STEPS) {
      expect(sqlFor(label), label).not.toContain("is_credit = true");
    }
  });
});

describe("aggregate-stats — the yearly series falls to zero with its source", () => {
  it("sweeps stale grant years, as it already did for contracts", () => {
    const grants = sqlFor("Zero stale yearly grant stats");

    expect(grants).toContain("UPDATE entity_yearly_stats");
    expect(grants).toContain("total_amount = 0");
    expect(grants).toContain("grant_count = 0");
    // Only rows that still carry money: the sweep is cheap and idempotent.
    expect(grants).toMatch(/WHERE\s+eys\.total_amount > 0/);
    expect(grants).toContain("NOT EXISTS");
    expect(sqlFor("Zero stale yearly contract stats")).toContain("NOT EXISTS");
  });

  /**
   * The anti-join has to look for exactly what the upsert counted. A sweep
   * that ignored `is_credit` would spare a year whose only remaining grants
   * are loans; one that ignored `ccaa_code` would spare a year held up by
   * rows the upsert never counted.
   */
  it("looks for grants under the same predicate the upsert counts them", () => {
    const upsert = sqlFor("Upsert yearly grant stats");
    const sweep = sqlFor("Zero stale yearly grant stats");

    for (const predicate of [
      "superseded IS NOT TRUE",
      "is_credit IS NOT TRUE",
      "ccaa_code = 'CAT'",
    ]) {
      expect(upsert, predicate).toContain(predicate);
      expect(sweep, predicate).toContain(predicate);
    }
  });

  it("matches the row it sweeps by entity and year", () => {
    const sweep = sqlFor("Zero stale yearly grant stats");

    expect(sweep).toContain("g.entity_id = eys.entity_id");
    expect(sweep).toContain("g.grant_year = eys.year");
  });
});

describe("aggregate-stats: what the comment above step 2 says is what the statement does", () => {
  const comment = /\/\/ Step 2: Grant yearly stats\n((?:\s*\/\/.*\n)+)/.exec(SOURCE)?.[1] ?? "";

  it("says the credits are EXCLUDED from the yearly total_amount, as the filter does", () => {
    expect(comment).not.toBe("");
    expect(comment).toMatch(/credits excluded/i);
    expect(comment).not.toMatch(/credits included/i);
    expect(sqlFor("Upsert yearly grant stats")).toContain("is_credit IS NOT TRUE");
  });

  it("says where the credits of a year are, since they are not in total_amount", () => {
    expect(comment).toContain("credit_amount");
  });
});
