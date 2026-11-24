import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGGREGATE_STATS_STEP_ORDER } from "../../src/lib/aggregate-stats-steps";

describe("aggregate-stats step order", () => {
  it("keeps contract entity_id backfill before contract totals", () => {
    const ids = AGGREGATE_STATS_STEP_ORDER.map((step) => step.id);

    expect(ids).toContain("contract_entity_id_backfill");
    expect(ids).toContain("contract_totals_via_entity_id");
    expect(ids.indexOf("contract_entity_id_backfill")).toBeLessThan(
      ids.indexOf("contract_totals_via_entity_id")
    );
  });

  it("keeps the executable SQL backfill before Contract totals via entity_id", () => {
    const aggregateStatsPath = fileURLToPath(new URL("../../src/pipeline/aggregate-stats.ts", import.meta.url));
    const source = readFileSync(aggregateStatsPath, "utf8");

    const cifBackfill = source.indexOf("Backfill contract entity_id (CIF)");
    const slugBackfill = source.indexOf("Backfill contract entity_id (slug fallback, no-CIF only)");
    const contractTotals = source.indexOf("Contract totals via entity_id");

    expect(cifBackfill).toBeGreaterThanOrEqual(0);
    expect(slugBackfill).toBeGreaterThanOrEqual(0);
    expect(contractTotals).toBeGreaterThanOrEqual(0);
    expect(cifBackfill).toBeLessThan(slugBackfill);
    expect(slugBackfill).toBeLessThan(contractTotals);
  });
});
