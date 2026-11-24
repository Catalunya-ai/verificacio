-- =====================================================================
-- Granting bodies ("Qui atorga"): totals per department, share of grants
-- awarded through a public call, and the AIReF-style semaphore; per year,
-- per purpose and top beneficiaries. Refreshed by aggregate-stats.ts (step 8).
--
-- Copied verbatim from the production schema; only
-- IF NOT EXISTS was added, so the file can be run again.
-- =====================================================================

-- Source: production schema
CREATE MATERIALIZED VIEW IF NOT EXISTS grant_organ_mv AS
WITH classified AS (
  SELECT
    g.department,
    g.amount,
    g.entity_id,
    g.grant_year,
    g.finalitat_rais,
    CASE
      WHEN g.convocatoria ~* '(convoca|resolucio|resolució|beca|borsa|ajut)' THEN 'competitive'
      WHEN g.convocatoria ~* 'prestaci' THEN 'statutory'
      WHEN g.convocatoria IS NULL OR g.convocatoria = '' THEN 'unknown'
      ELSE 'other_discretionary'
    END AS grant_type
  FROM grants g
  WHERE g.superseded IS NOT TRUE
    AND g.department IS NOT NULL
    AND g.amount > 0
),
dept_agg AS (
  SELECT
    department,
    COUNT(*) AS total_grants,
    SUM(amount) AS total_amount,
    COUNT(DISTINCT entity_id) FILTER (WHERE entity_id IS NOT NULL) AS unique_beneficiaries,
    -- Competitive ratio: competitive / (competitive + other_discretionary)
    -- unknown excluded from denominator to avoid penalizing depts with missing convocatoria
    ROUND(
      100.0 * COUNT(*) FILTER (WHERE grant_type = 'competitive')
      / NULLIF(COUNT(*) FILTER (WHERE grant_type IN ('competitive', 'other_discretionary')), 0),
      2
    ) AS pct_competitive,
    -- Statutory ratio (used for Tier B classification)
    ROUND(
      100.0 * COUNT(*) FILTER (WHERE grant_type = 'statutory')
      / NULLIF(COUNT(*), 0),
      2
    ) AS pct_statutory,
    -- Primary finalitat: most frequent non-null value
    mode() WITHIN GROUP (ORDER BY finalitat_rais) AS primary_finalitat
  FROM classified
  GROUP BY department
  HAVING COUNT(*) >= 10 AND SUM(amount) >= 100000
)
SELECT
  da.department,
  slugify_organ(da.department) AS department_slug,
  da.total_grants,
  da.total_amount,
  da.unique_beneficiaries,
  da.pct_competitive,
  da.pct_statutory,
  NULL::NUMERIC AS cr10,          -- deferred: expensive window function, add via UPDATE later
  NULL::NUMERIC AS pct_recurrence, -- deferred: expensive consecutive-years detection
  CASE WHEN da.pct_statutory >= 60 THEN 'B' ELSE 'A' END AS organism_tier,
  CASE
    WHEN da.pct_statutory >= 60 THEN NULL  -- Tier B: no AIReF semaphore
    WHEN da.pct_competitive < 30 THEN 'RED'
    WHEN da.pct_competitive >= 60 THEN 'GREEN'
    ELSE 'AMBER'
  END AS airef_semaphore,
  da.primary_finalitat
FROM dept_agg da;

-- Source: production schema
CREATE UNIQUE INDEX IF NOT EXISTS idx_grant_organ_mv_department ON grant_organ_mv(department);

-- Source: production schema
CREATE UNIQUE INDEX IF NOT EXISTS idx_grant_organ_mv_slug ON grant_organ_mv(department_slug);

-- Source: production schema
CREATE MATERIALIZED VIEW IF NOT EXISTS grant_organ_yearly_mv AS
WITH classified AS (
  SELECT
    department,
    grant_year,
    amount,
    CASE
      WHEN convocatoria ~* '(convoca|resolucio|resolució|beca|borsa|ajut)' THEN 'competitive'
      WHEN convocatoria ~* 'prestaci' THEN 'statutory'
      WHEN convocatoria IS NULL OR convocatoria = '' THEN 'unknown'
      ELSE 'other_discretionary'
    END AS grant_type
  FROM grants
  WHERE department IS NOT NULL
    AND superseded IS NOT TRUE
    AND grant_year IS NOT NULL
    AND amount > 0
)
SELECT
  department,
  grant_year::INT AS year,
  SUM(amount)::NUMERIC AS total_amount,
  COUNT(*)::BIGINT AS total_grants,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE grant_type = 'competitive')::NUMERIC
    / NULLIF(COUNT(*) FILTER (WHERE grant_type IN ('competitive','other_discretionary')), 0)::NUMERIC,
    2
  ) AS pct_competitive
FROM classified
GROUP BY department, grant_year;

-- Source: production schema
CREATE UNIQUE INDEX IF NOT EXISTS idx_grant_organ_yearly_mv_dept_year
  ON grant_organ_yearly_mv (department, year);

-- Source: production schema
CREATE MATERIALIZED VIEW IF NOT EXISTS grant_organ_finalitat_mv AS
WITH classified AS (
  SELECT
    department,
    -- Treat empty strings as NULL before the fallback, so
    -- blank finalitat_publica values don't surface as unlabelled pie slices.
    COALESCE(
      NULLIF(TRIM(finalitat_publica), ''),
      NULLIF(TRIM(finalitat_rais), ''),
      'Sense classificar'
    ) AS finalitat,
    amount
  FROM grants
  WHERE department IS NOT NULL
    AND superseded IS NOT TRUE
    AND amount > 0
),
agg AS (
  SELECT
    department,
    finalitat,
    SUM(amount)::NUMERIC AS total_amount,
    COUNT(*)::BIGINT AS total_grants
  FROM classified
  GROUP BY department, finalitat
),
totals AS (
  SELECT department, SUM(total_amount) AS dept_total
  FROM agg
  GROUP BY department
)
SELECT
  a.department,
  a.finalitat,
  a.total_amount,
  a.total_grants,
  ROUND(100.0 * a.total_amount / NULLIF(t.dept_total, 0), 2) AS pct_of_total,
  -- Tiebreaker on finalitat keeps ordering stable between refreshes.
  ROW_NUMBER() OVER (PARTITION BY a.department ORDER BY a.total_amount DESC, a.finalitat ASC) AS rank
FROM agg a
JOIN totals t ON t.department = a.department;

-- Source: production schema
CREATE UNIQUE INDEX IF NOT EXISTS idx_grant_organ_finalitat_mv_dept_rank
  ON grant_organ_finalitat_mv (department, rank);

-- Source: production schema
CREATE MATERIALIZED VIEW IF NOT EXISTS grant_organ_beneficiaris_mv AS
WITH agg AS (
  SELECT
    g.department,
    g.entity_id,
    SUM(g.amount)::NUMERIC AS total_amount,
    COUNT(*)::BIGINT AS total_grants,
    MIN(g.grant_year)::INT AS first_year,
    MAX(g.grant_year)::INT AS last_year
  FROM grants g
  JOIN entities e ON e.id = g.entity_id
  WHERE g.department IS NOT NULL
    AND g.superseded IS NOT TRUE
    AND g.entity_id IS NOT NULL
    AND g.amount > 0
    AND e.is_anonymized IS NOT TRUE
  GROUP BY g.department, g.entity_id
)
SELECT
  department,
  entity_id,
  total_amount,
  total_grants,
  first_year,
  last_year,
  -- Tiebreaker on entity_id keeps ordering stable between refreshes.
  ROW_NUMBER() OVER (PARTITION BY department ORDER BY total_amount DESC, entity_id ASC) AS rank
FROM agg;

-- Source: production schema
CREATE UNIQUE INDEX IF NOT EXISTS idx_grant_organ_beneficiaris_mv_dept_rank
  ON grant_organ_beneficiaris_mv (department, rank);
