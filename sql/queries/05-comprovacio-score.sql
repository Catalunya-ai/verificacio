-- =====================================================================
-- Checks on the stored score.
--
-- 1. The composite is the arithmetic mean of the components that are not
--    NULL (v5.1): recomputing it from the stored components must give the
--    stored value for every scored entity. Expected: 0 mismatches.
-- 2. Distribution by the published bands (Baix 0-25, Moderat 26-50,
--    Alt 51-75, Molt alt 76-100).
-- 3. How many entities have each component.
--
--   npx tsx src/pipeline/run-sql.ts sql/queries/05-comprovacio-score.sql
-- =====================================================================

\pset tuples_only off
\pset format aligned

WITH recomputed AS (
  SELECT id, menjometre_score,
    ROUND((
        COALESCE(score_volume, 0) + COALESCE(score_frequency, 0) + COALESCE(score_dominance, 0)
      + COALESCE(score_concurrencia, 0) + COALESCE(score_accountability, 0)
    ) / NULLIF(
        (score_volume IS NOT NULL)::int + (score_frequency IS NOT NULL)::int
      + (score_dominance IS NOT NULL)::int + (score_concurrencia IS NOT NULL)::int
      + (score_accountability IS NOT NULL)::int, 0)::numeric, 2) AS mean_of_components
  FROM entities
  WHERE menjometre_score > 0
)
SELECT COUNT(*) AS "entitats amb score",
       COUNT(*) FILTER (WHERE mean_of_components IS DISTINCT FROM menjometre_score) AS "discrepàncies"
FROM recomputed;

SELECT CASE
         WHEN menjometre_score > 75 THEN '4 Molt alt (76-100)'
         WHEN menjometre_score > 50 THEN '3 Alt (51-75)'
         WHEN menjometre_score > 25 THEN '2 Moderat (26-50)'
         ELSE '1 Baix (0-25)'
       END AS "banda",
       COUNT(*) AS "entitats"
FROM entities
WHERE menjometre_score > 0
GROUP BY 1
ORDER BY 1;

SELECT COUNT(*) FILTER (WHERE score_volume IS NOT NULL)         AS "volum",
       COUNT(*) FILTER (WHERE score_frequency IS NOT NULL)      AS "freqüència",
       COUNT(*) FILTER (WHERE score_dominance IS NOT NULL)      AS "dominància",
       COUNT(*) FILTER (WHERE score_concurrencia IS NOT NULL)   AS "concurrència",
       COUNT(*) FILTER (WHERE score_accountability IS NOT NULL) AS "transparència comptable"
FROM entities
WHERE menjometre_score > 0;
