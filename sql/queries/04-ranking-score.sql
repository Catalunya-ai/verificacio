-- =====================================================================
-- The ranking of beneficiaries by Menjòmetre score.
--
-- Same base filters as the public grants ranking: at least one grant,
-- grants of 1.000 EUR or more, not anonymised, not a natural person.
--
--   npx tsx src/pipeline/run-sql.ts sql/queries/04-ranking-score.sql
-- =====================================================================

\pset tuples_only off
\pset format aligned

SELECT
  row_number() OVER (ORDER BY menjometre_score DESC, total_public_funds DESC) AS "posició",
  name, cif,
  menjometre_score   AS "score",
  score_volume       AS "V",
  score_frequency    AS "F",
  score_dominance    AS "D",
  score_concurrencia AS "C",
  score_accountability AS "A",
  total_public_funds AS "fons públics (EUR)"
FROM entities
WHERE total_grants > 0
  AND total_amount >= 1000
  AND is_anonymized = false
  AND is_person = false
ORDER BY menjometre_score DESC, total_public_funds DESC
LIMIT 50;
