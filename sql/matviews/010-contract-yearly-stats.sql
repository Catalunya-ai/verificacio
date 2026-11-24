-- =====================================================================
-- contract_yearly_stats_mv: live contracts per year and contract type.
-- Refreshed by aggregate-stats.ts (step 8) and sync-contractes.ts.
--
-- Copied verbatim from the production schema; only
-- IF NOT EXISTS was added, so the file can be run again.
-- =====================================================================

-- Source: production schema
-- Materialized view for contract yearly totals (replaces 1.7M row scan with ~40 row lookup)
CREATE MATERIALIZED VIEW IF NOT EXISTS contract_yearly_stats_mv AS
SELECT
  contract_year AS year,
  COALESCE(contract_type, 'Altres') AS contract_type,
  SUM(amount) AS total_amount,
  COUNT(*) AS total_contracts
FROM contracts
WHERE superseded IS NOT TRUE
  AND contract_year IS NOT NULL
GROUP BY contract_year, COALESCE(contract_type, 'Altres');

-- Source: production schema
CREATE UNIQUE INDEX IF NOT EXISTS contract_yearly_stats_mv_year_contract_type_idx ON contract_yearly_stats_mv (year, contract_type);
