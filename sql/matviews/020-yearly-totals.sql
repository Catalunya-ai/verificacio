-- =====================================================================
-- yearly_totals_mv: per-year totals of entity_yearly_stats (grants without
-- ICF credits, and contracts). Refreshed by aggregate-stats.ts (step 8).
--
-- Copied verbatim from the production schema; only
-- IF NOT EXISTS was added, so the file can be run again.
-- =====================================================================

-- Source: production schema
CREATE MATERIALIZED VIEW IF NOT EXISTS public.yearly_totals_mv AS
SELECT
  s.year,
  COALESCE(SUM(s.grant_count), 0)::bigint     AS grant_count,
  COALESCE(SUM(s.total_amount), 0)            AS grant_amount,
  COALESCE(SUM(s.contract_count), 0)::bigint  AS contract_count,
  COALESCE(SUM(s.contract_amount), 0)         AS contract_amount
FROM public.entity_yearly_stats s
WHERE s.year IS NOT NULL
GROUP BY s.year;

-- Source: production schema
CREATE UNIQUE INDEX IF NOT EXISTS yearly_totals_mv_year ON public.yearly_totals_mv (year);
