-- =====================================================================
-- One entity: its totals per channel and the five components of its score.
--
-- Pass the entity by CIF or by slug (the last part of its URL):
--   npx tsx src/pipeline/run-sql.ts sql/queries/02-fitxa-entitat.sql id=G12345678
--   npx tsx src/pipeline/run-sql.ts sql/queries/02-fitxa-entitat.sql id=FUNDACIO-EXEMPLE
-- =====================================================================

\pset tuples_only off
\pset format aligned
\x on

SELECT
  name, slug, cif,
  total_amount               AS "subvencions (EUR)",
  total_grants               AS "subvencions (nombre)",
  first_grant_year           AS "primer any",
  last_grant_year            AS "darrer any",
  total_credit_amount        AS "crèdits ICF (EUR, a part)",
  total_contract_amount      AS "contractes (EUR, sense IVA)",
  total_contracts            AS "contractes (nombre)",
  total_budget_transfers     AS "transferències cap. 4/7 (EUR)",
  total_equity_contributions AS "aportacions de capital cap. 8 art. 87 (EUR)",
  total_accio_concertada     AS "acció concertada (EUR)",
  total_public_funds         AS "fons públics totals (EUR)",
  total_conveni_amount       AS "convenis (EUR, fora del total)",
  menjometre_score           AS "score Menjòmetre",
  score_volume               AS "volum",
  score_frequency            AS "freqüència",
  score_dominance            AS "dominància",
  score_concurrencia         AS "concurrència",
  idx_market_competition     AS "índex de competència del mercat",
  score_accountability       AS "transparència comptable",
  fragmentation_count        AS "contractes a la franja de fragmentació",
  fragmentation_risk         AS "% de contractes a la franja"
FROM entities
WHERE cif = upper(:'id') OR slug = :'id';
