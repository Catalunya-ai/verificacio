import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LCSP_MENOR_THRESHOLD,
  ROBUSTNESS_FLOOR,
  SCORING_THRESHOLD,
  SCORING_VERSION,
} from "../../src/lib/scoring-config";

/** The five score columns and how they are combined, as the methodology states it. */
const SCORING_COMPONENTS = [
  { field: "score_volume" },
  { field: "score_frequency" },
  { field: "score_dominance" },
  { field: "score_concurrencia" },
  { field: "score_accountability" },
] as const;
const SCORE_COMPOSITION = {
  aggregation: "arithmetic_mean_non_null",
  component_count: { min: 1, max: 5 },
} as const;

/**
 * The score is computed by the SQL inside calculate-scores-sql.ts; the
 * published configuration lives in scoring-config.ts and METODOLOGIA.md.
 * These tests read the SQL itself and check that every threshold, floor and
 * the composition formula are the documented ones.
 */

const root = resolve(__dirname, "..", "..");
const SOURCE = readFileSync(resolve(root, "src/pipeline/calculate-scores-sql.ts"), "utf8");
const METHODOLOGY = readFileSync(resolve(root, "METODOLOGIA.md"), "utf8");

/** The SQL of one `runSQL("<label>", ...)` call. */
function sqlFor(label: string): string {
  const match = new RegExp(
    `runSQL\\(\\s*"${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",\\s*\`([\\s\\S]*?)\`\\s*\\)`
  ).exec(SOURCE);
  expect(match, `no runSQL step labelled "${label}"`).not.toBeNull();
  return match![1]!;
}

const compact = (sql: string) => sql.replace(/\s+/g, " ");

describe("eligibility threshold", () => {
  it("volume scores the entities with at least one transaction and 25.000 EUR", () => {
    const sql = compact(sqlFor("Volume"));
    expect(SCORING_THRESHOLD).toEqual({ minTransactions: 1, minPublicFunds: 25_000 });
    expect(sql).toContain(`(total_grants + COALESCE(total_contracts, 0)) >= ${SCORING_THRESHOLD.minTransactions}`);
    expect(sql).toContain(`COALESCE(total_public_funds, total_amount) >= ${SCORING_THRESHOLD.minPublicFunds}`);
    expect(sql).toContain("is_anonymized = false");
  });

  it("the composite is zero below the threshold and computed above it", () => {
    const zero = compact(sqlFor("Zero below-threshold"));
    expect(zero).toContain("menjometre_score = 0");
    expect(zero).toContain(`< ${SCORING_THRESHOLD.minTransactions}`);
    expect(zero).toContain(`< ${SCORING_THRESHOLD.minPublicFunds}`);
    const composite = compact(sqlFor("Equal-weight score (v5.1)"));
    expect(composite).toContain(`>= ${SCORING_THRESHOLD.minTransactions}`);
    expect(composite).toContain(`>= ${SCORING_THRESHOLD.minPublicFunds}`);
  });
});

describe("components", () => {
  it("volume and frequency are population percentiles", () => {
    expect(sqlFor("Volume")).toContain("PERCENT_RANK() OVER (ORDER BY funds ASC)");
    expect(sqlFor("Frequency")).toContain("PERCENT_RANK() OVER (ORDER BY tpy ASC)");
  });

  it("frequency needs 100.000 EUR of public funds", () => {
    expect(ROBUSTNESS_FLOOR.frequencyMinPublicFunds).toBe(100_000);
    expect(compact(sqlFor("Frequency"))).toContain(
      `COALESCE(total_public_funds, total_amount) >= ${ROBUSTNESS_FLOOR.frequencyMinPublicFunds}`
    );
  });

  it("dominance needs 100.000 EUR in the primary group and groups of 10 or more", () => {
    expect(ROBUSTNESS_FLOOR.dominanceMinPurposeAmount).toBe(100_000);
    const grants = compact(sqlFor("Grant dominance"));
    expect(grants).toContain(`entity_purpose_amount >= ${ROBUSTNESS_FLOOR.dominanceMinPurposeAmount}`);
    expect(grants).toContain("HAVING COUNT(*) >= 10");
    expect(grants).toContain("PERCENT_RANK() OVER (PARTITION BY pp.purpose_key ORDER BY pp.entity_purpose_amount)");
    const contracts = compact(sqlFor("Contract CPV dominance + weighted combo"));
    expect(contracts).toContain(`cpv_amount >= ${ROBUSTNESS_FLOOR.dominanceMinPurposeAmount}`);
    expect(contracts).toContain("cgc.n >= 10");
  });

  it("dominance weights grants and contracts by their share of public funds", () => {
    const sql = compact(sqlFor("Contract CPV dominance + weighted combo"));
    expect(sql).toContain("(COALESCE(e.total_amount, 0) / e.total_public_funds) * COALESCE(e.score_dominance, 0)");
    expect(sql).toContain("(COALESCE(e.total_contract_amount, 0) / e.total_public_funds) * COALESCE(cd.dom_cpv, 0)");
  });

  it("concurrència leaves out minor contracts under the LCSP art. 118 thresholds", () => {
    expect(LCSP_MENOR_THRESHOLD).toEqual({ obres: 40_000, serveisSubministraments: 15_000 });
    const sql = compact(sqlFor("Market Competition Index"));
    expect(sql).toContain(
      `c.procedure_type = 'Contracte menor' AND c.contract_type = 'Obres' AND c.amount < ${LCSP_MENOR_THRESHOLD.obres} THEN 'MENOR_LEGAL'`
    );
    expect(sql).toContain(
      `c.procedure_type = 'Contracte menor' AND c.contract_type IN ('Serveis', 'Subministraments') AND c.amount < ${LCSP_MENOR_THRESHOLD.serveisSubministraments} THEN 'MENOR_LEGAL'`
    );
    expect(sql).toContain("NOT IN ('UNKNOWN', 'MENOR_LEGAL')");
  });

  it("concurrència needs 25.000 EUR of classifiable contracts and is an absolute share", () => {
    expect(ROBUSTNESS_FLOOR.concurrenciaMinClassifiableAmount).toBe(25_000);
    const sql = compact(sqlFor("Market Competition Index"));
    expect(sql).toContain(`ec.classifiable_amount >= ${ROBUSTNESS_FLOOR.concurrenciaMinClassifiableAmount}`);
    expect(sql).toContain("ec.pct_non_competitive * 100 AS idx_market_raw");
    // No population percentile in the statement itself (its comments may name one).
    const code = sqlFor("Market Competition Index").replace(/--[^\n]*/g, "");
    expect(code).not.toContain("PERCENT_RANK");
  });

  it("fragmentation enters concurrència at 30% only with 5+ contracts and 5%+ in the band", () => {
    const sql = compact(sqlFor("Concurrència composite"));
    expect(sql).toContain("fragmentation_count >= 5");
    expect(sql).toContain("fragmentation_risk >= 5");
    expect(sql).toContain("0.70 * COALESCE(e.idx_market_competition, 0) + 0.30 * fe.frag_score");
  });
});

describe("composition", () => {
  it("is the mean of the components that are not NULL", () => {
    const sql = compact(sqlFor("Equal-weight score (v5.1)"));
    for (const field of SCORING_COMPONENTS.map((c) => c.field)) {
      expect(sql).toContain(`COALESCE(${field}, 0)`);
      expect(sql).toContain(`CASE WHEN ${field} IS NOT NULL THEN 1 ELSE 0 END`);
    }
    expect(SCORE_COMPOSITION.aggregation).toBe("arithmetic_mean_non_null");
    expect(SCORE_COMPOSITION.component_count).toEqual({ min: 1, max: SCORING_COMPONENTS.length });
    expect(SCORING_COMPONENTS).toHaveLength(5);
  });

  it("the methodology states the configured version", () => {
    expect(SCORING_VERSION).toBe("v5.1");
    expect(METHODOLOGY).toContain(`Versió configurada: ${SCORING_VERSION}`);
  });
});
