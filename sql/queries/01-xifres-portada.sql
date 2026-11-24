-- =====================================================================
-- Headline figures: grants, contracts, budget transfers and entities.
--
-- Same expressions as the production home-page totals; the other home-page
-- counts come from data that is not in this repository.
--
-- Run: npx tsx src/pipeline/run-sql.ts sql/queries/01-xifres-portada.sql
-- =====================================================================

\pset tuples_only off
\pset format aligned

WITH recent_bounds AS (
  -- Last year with material data. It is the PARTIAL current year: excluded.
  SELECT MAX(y.year) AS max_year
  FROM entity_yearly_stats y
  WHERE y.total_amount > 0
),
recent AS (
  SELECT
    COALESCE(SUM(ys.total_amount), 0)::numeric AS recent_amount,
    COALESCE(SUM(ys.grant_count), 0)::bigint   AS recent_grant_count,
    MIN(ys.year)::int                          AS recent_first_year,
    MAX(ys.year)::int                          AS recent_last_year
  FROM entity_yearly_stats ys
  CROSS JOIN recent_bounds rb
  WHERE ys.year >= rb.max_year - 3
    AND ys.year <  rb.max_year
),
base AS (
  SELECT
    COALESCE(sum(total_amount), 0::numeric) AS total_amount,
    count(*) FILTER (WHERE is_anonymized = false AND is_person = false) AS entity_count,
    COALESCE(sum(total_grants), 0::bigint) AS grant_count,
    COALESCE(sum(total_contract_amount), 0::numeric) AS contract_amount,
    COALESCE(sum(total_contracts), 0::bigint) AS contract_count,
    count(*) FILTER (WHERE is_anonymized = false AND is_person = false AND total_contracts > 0) AS contractor_count,
    COALESCE(sum(total_budget_transfers), 0::numeric) AS budget_transfer_amount,
    count(*) FILTER (WHERE is_anonymized = false AND is_person = false AND total_budget_transfers > 0::numeric) AS budget_transfer_entity_count,
    count(*) FILTER (WHERE is_anonymized = false AND is_person = false AND menjometre_score > 0::numeric) AS scored_entity_count
  FROM entities
  WHERE total_grants > 0 OR total_contracts > 0 OR total_budget_transfers > 0::numeric
)
SELECT
  b.total_amount            AS "subvencions (EUR, sense crèdits ICF)",
  b.grant_count             AS "subvencions (nombre)",
  b.contract_amount         AS "contractes (EUR, sense IVA)",
  b.contract_count          AS "contractes (nombre)",
  b.contractor_count        AS "entitats adjudicatàries",
  b.budget_transfer_amount  AS "transferències pressupostàries (EUR)",
  b.budget_transfer_entity_count AS "entitats amb transferències",
  b.entity_count            AS "entitats",
  b.scored_entity_count     AS "entitats amb score",
  r.recent_amount           AS "subvencions darrers anys tancats (EUR)",
  r.recent_grant_count      AS "subvencions darrers anys tancats (nombre)",
  r.recent_first_year       AS "des de",
  r.recent_last_year        AS "fins a"
FROM base b
CROSS JOIN recent r;
