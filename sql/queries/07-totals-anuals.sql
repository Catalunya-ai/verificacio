-- =====================================================================
-- Totals per year: grants (without ICF credits) and contracts, from the
-- per-entity series (yearly_totals_mv), and contracts per contract type
-- (contract_yearly_stats_mv).
--
--   npx tsx src/pipeline/run-sql.ts sql/queries/07-totals-anuals.sql
-- =====================================================================

\pset tuples_only off
\pset format aligned

SELECT year            AS "any",
       grant_amount    AS "subvencions (EUR)",
       grant_count     AS "subvencions (nombre)",
       contract_amount AS "contractes (EUR)",
       contract_count  AS "contractes (nombre)"
FROM yearly_totals_mv
ORDER BY year;

SELECT year AS "any", contract_type AS "tipus de contracte",
       total_amount AS "EUR", total_contracts AS "contractes"
FROM contract_yearly_stats_mv
ORDER BY year, total_amount DESC;
