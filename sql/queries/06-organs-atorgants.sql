-- =====================================================================
-- Granting bodies: amount, beneficiaries, share of grants through a public
-- call and the semaphore (grant_organ_mv, refreshed by aggregate-stats.ts).
--
-- The semaphore: Tier B (no colour) when 60% or more of the grants are
-- statutory benefits; otherwise RED below 30% through a public call, GREEN
-- from 60%, AMBER in between. Only bodies with 10+ grants and 100.000 EUR+.
--
--   npx tsx src/pipeline/run-sql.ts sql/queries/06-organs-atorgants.sql
-- =====================================================================

\pset tuples_only off
\pset format aligned

SELECT department           AS "organisme",
       total_amount         AS "EUR",
       total_grants         AS "subvencions",
       unique_beneficiaries AS "beneficiaris",
       pct_competitive      AS "% convocatòria",
       pct_statutory        AS "% prestacions",
       organism_tier        AS "tipus",
       airef_semaphore      AS "semàfor"
FROM grant_organ_mv
ORDER BY total_amount DESC
LIMIT 50;
