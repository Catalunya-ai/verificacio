-- =====================================================================
-- One entity, year by year: grants (without ICF credits) and contracts.
--
--   npx tsx src/pipeline/run-sql.ts sql/queries/03-serie-anual-entitat.sql id=G12345678
--
-- The grants of a year add up to entities.total_amount; the contracts of a
-- year add up to entities.total_contract_amount (rows with a year only).
-- =====================================================================

\pset tuples_only off
\pset format aligned

SELECT y.year            AS "any",
       y.total_amount    AS "subvencions (EUR)",
       y.grant_count     AS "subvencions (nombre)",
       y.contract_amount AS "contractes (EUR)",
       y.contract_count  AS "contractes (nombre)"
FROM entity_yearly_stats y
JOIN entities e ON e.id = y.entity_id
WHERE e.cif = upper(:'id') OR e.slug = :'id'
ORDER BY y.year;

-- The same totals recomputed from the individual rows, to check the series.
SELECT 'subvencions' AS "font", g.grant_year AS "any", SUM(g.amount) AS "EUR", COUNT(*) AS "nombre"
FROM grants g
JOIN entities e ON e.id = g.entity_id
WHERE (e.cif = upper(:'id') OR e.slug = :'id')
  AND g.superseded IS NOT TRUE AND g.is_credit IS NOT TRUE AND g.grant_year IS NOT NULL
  AND (g.source_dataset = 'raisc_concessions' OR g.ccaa_code = 'CAT')
GROUP BY g.grant_year
UNION ALL
SELECT 'contractes', c.contract_year, SUM(c.amount), COUNT(*)
FROM contracts c
JOIN entities e ON e.id = c.entity_id
WHERE (e.cif = upper(:'id') OR e.slug = :'id')
  AND c.superseded IS NOT TRUE AND c.contract_year IS NOT NULL
GROUP BY c.contract_year
ORDER BY 1, 2;
