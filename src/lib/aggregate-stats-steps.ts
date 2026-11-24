export const AGGREGATE_STATS_STEP_ORDER = [
  { id: "grant_totals", label: "Step 1: Aggregating grant totals per entity (excl. credits)" },
  { id: "credit_totals", label: "Step 1b: Aggregating credit totals per entity" },
  { id: "grant_yearly_stats", label: "Step 2: Upserting grant yearly stats" },
  { id: "contract_cif_backfill_skipped", label: "Step 3: CIF backfill from contracts SKIPPED (unreliable source)" },
  { id: "contract_dedup", label: "Step 3b: Dedup alternative-expedient contracts" },
  { id: "contract_entity_id_backfill", label: "Step 3c: Backfilling contract entity_id" },
  { id: "contract_totals_via_entity_id", label: "Step 4: Aggregating contract stats (CIF-first)" },
  { id: "conveni_totals", label: "Step 4b: Aggregating conveni stats" },
  { id: "budget_transfer_totals", label: "Step 4c: Aggregating budget transfers" },
  { id: "accio_concertada_totals", label: "Step 4d: Aggregating accio concertada" },
  { id: "equity_contribution_totals", label: "Step 4e: Aggregating equity contributions (Cap.8 art.87)" },
  { id: "total_public_funds", label: "Step 5: Computing total_public_funds (grants + contracts + transfers + accio concertada + equity, NO convenis)" },
  { id: "yearly_contract_stats", label: "Step 6: Upserting yearly contract stats" },
  { id: "primary_contract_fields", label: "Step 7: Populating primary organ and contract type" },
  { id: "materialized_views", label: "Step 8: Refreshing materialized views" },
  { id: "vacuum_contracts", label: "Step 9: VACUUM ANALYZE contracts" },
  { id: "final_invariants", label: "Step 10: Checking final aggregation invariants" },
] as const;

export type AggregateStatsStepId = (typeof AGGREGATE_STATS_STEP_ORDER)[number]["id"];

export function aggregateStatsStepLabel(id: AggregateStatsStepId): string {
  const step = AGGREGATE_STATS_STEP_ORDER.find((item) => item.id === id);
  if (!step) throw new Error(`Unknown aggregate-stats step: ${id}`);
  return step.label;
}
