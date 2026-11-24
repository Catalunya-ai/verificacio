-- Same SQL as the production step, except the header and the grants to hosted API roles.
-- =====================================================================
-- reconcile-entity-stubs.sql — fold empty duplicate stubs into their
-- canonical funded twins. Idempotent; safe to re-run after every sync.
-- SET-BASED: one UPDATE per FK column (not per stub), with a per-row
-- ctid fallback only on the few tables that hit a unique collision.
-- Backup table suffixes are dated so one run cannot destroy the previous
-- run's safety copy.
--
-- Tier A: stub (no cif, no grants, no contracts, 0 funds) whose normalized
-- name (punctuation/space-insensitive) matches EXACTLY ONE funded CIF.
--
-- Tier B: stub (no cif, 0 funds, no grants, no contracts, not anonymized, not a
-- person) whose COMPACT SLUG (slug minus hyphens, >= 8 chars) equals the compact
-- slug of EXACTLY ONE funded CIF entity, and is not already in Tier A. This
-- catches the twin that Tier A cannot see when entities.name is truncated to 35 chars
-- but the slug happens to come from the full-name source variant. The slug is derived from the same source string as the name and is cut too in
-- most truncated cases (Tier C below covers those).
-- A slug only says what the entity was CALLED when it was created, so Tier B also
-- requires the NAMES to agree (legal-form-insensitive: similarity >= 0.5, one
-- contains the other, or the target carries a placeholder "Empresa <CIF>" name).
-- Stubs that fail this check are listed, not merged. Override for a deliberate
-- run:  psql ... -v tierb_name_check=off
--
-- Not merged, printed for manual review at the end:
--   * ambiguous          — more than one funded CIF shares the compact slug
--   * has grants/contracts — the stub is not empty
--   * name conflict      — slug agrees, names do not (renamed / wrong CIF data)
--   * skipped: conflicting redirect (ALL tiers, A included) — slug_redirects already
--                          sends the stub's slug to a CIF that is neither the twin's CIF
--                          nor one of its alt_cifs / cif_aliases (two CIFs for one name:
--                          one of them is wrong data; conflicting evidence is not merged)
--
-- Tier C (OPT-IN, default OFF — the default run only REPORTS it): the source data cuts
-- entities.name at 35 characters, so a funded CIF entity may hold a truncated name while
-- an empty CIF-less stub holds the full one, and neither the name (Tier A) nor the slug
-- (Tier B; ~90% of truncated rows have a truncated slug too) can pair them. Tier C pairs
-- a stub (same filter as A/B: no cif, 0 funds, no grants/contracts, not anonymized, not a
-- person) whose COMPACT NAME extends (starts with, and is longer than) the compact name
-- of a funded CIF entity with length(name) = 35 and compact name >= 25 chars, with
-- EXACTLY ONE such funded CIF. Enable with:  psql ... -v include_tier_c=on
--   RISK: a DIFFERENT entity can share a 35-char prefix (e.g. ten different "Agrupacio de
--   Defensa Forestal (ADF) <municipi>" all extend one truncated "AGRUPACIO DE DEFENSA
--   FORESTAL - ADF"; a joint bid "COMPANY A||COMPANY B" starts with company A's name).
--   That is why C is opt-in and must be reviewed on the printed sample first. Guards
--   that keep such stubs out of the merge set (listed, not merged):
--     * many_stubs   — more than tierc_max_stubs (default 3; -v tierc_max_stubs=N) stubs
--                      extend the same truncated target (one entity rarely has >3 spellings)
--     * joint_name   — the stub name contains "||" (several suppliers joined by the source)
--     * has_grants_or_contracts, ambiguous, redirect_conflict — as in Tier B
--   Stubs already handled or held by Tier A/B are never Tier C candidates.
--
-- Every merge is logged with a `tier` column ('A','B','C') in stub_merge_log_<suffix>, so
-- review and rollback can filter by tier. Nothing is backed up or merged when there is
-- nothing to merge (no empty backup tables per run).
--
-- Every merged stub keeps working as an alias (also_known_as -> aka_norm by trigger,
-- slug_aliases) AND as a URL (slug_redirects old_slug -> CIF).
--
-- Invariants asserted inside the transaction (it aborts if any fails):
--   * entity count drops by exactly the number of merged stubs
--   * sum(total_public_funds / total_grants / total_contracts) unchanged
--   * no grants/contracts row was moved or dropped (stubs carry none)
--   * no FK column on a table > 1M rows lacks a usable index (planner guard)
--
-- Run inside a single transaction so any failure rolls back:
--   npx tsx src/pipeline/run-sql.ts sql/pipeline/020-reconcile-entity-stubs.sql --single-transaction
-- =====================================================================
\pset pager off
\if :{?tierb_name_check}
\else
  \set tierb_name_check on
\endif
\if :{?include_tier_c}
\else
  \set include_tier_c off
\endif
\if :{?tierc_max_stubs}
\else
  \set tierc_max_stubs 3
\endif

-- Name key used by the Tier B agreement check: unaccented, upper-case, punctuation
-- and legal-form tokens (SL, SLU, SA, SAU, SCCL, SLL, SCP, CB, SRL, SOCIEDAD ...)
-- removed, spaces removed.
CREATE FUNCTION pg_temp.name_key(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(regexp_replace(
    regexp_replace(upper(public.immutable_unaccent(coalesce(t,''))), '[^A-Z0-9]+', ' ', 'g'),
    '\m(SOCIEDAD LIMITADA UNIPERSONAL|SOCIETAT LIMITADA UNIPERSONAL|SOCIEDAD LIMITADA|SOCIEDAD ANONIMA|SOCIETAT LIMITADA|SOCIETAT ANONIMA|SOCIEDAD UNIPERSONAL|SOCIETAT UNIPERSONAL|S L U|S L L|S C C L|S A U|S C P|S R L|S L|S A|C B|SLU|SLL|SCCL|SAU|SCP|SRL|SL|SA|CB)\M',
    ' ', 'g'), ' ', '')
$$;

-- ── invariants before ────────────────────────────────────────────────
DROP TABLE IF EXISTS _inv_before;
CREATE TEMP TABLE _inv_before AS
SELECT count(*) AS n_entities,
       COALESCE(sum(total_public_funds), 0) AS sum_funds,
       COALESCE(sum(total_grants), 0)       AS sum_grants,
       COALESCE(sum(total_contracts), 0)    AS sum_contracts
FROM entities;

-- ── Tier A candidate pairs ───────────────────────────────────────────
DROP TABLE IF EXISTS _tiera;
CREATE TEMP TABLE _tiera AS
WITH norm AS (
  SELECT id, slug, name, cif, total_public_funds,
         upper(regexp_replace(translate(name, '.,-/()''', ''), '\s+', '', 'g')) AS nkey
  FROM entities
),
stubs AS (
  SELECT n.* FROM norm n
  WHERE n.cif IS NULL AND COALESCE(n.total_public_funds, 0) = 0 AND length(n.nkey) >= 6
    AND NOT EXISTS (SELECT 1 FROM grants g    WHERE g.entity_id = n.id)
    AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.entity_id = n.id)
),
funded AS (
  SELECT n.* FROM norm n WHERE n.cif IS NOT NULL AND n.total_public_funds > 0
),
pairs AS (
  SELECT s.id AS stub_id, s.slug AS stub_slug, s.name AS stub_name,
         COUNT(DISTINCT f.cif) AS n_targets,
         (array_agg(f.id ORDER BY f.total_public_funds DESC))[1] AS target_id
  FROM stubs s JOIN funded f ON f.nkey = s.nkey
  GROUP BY s.id, s.slug, s.name
)
SELECT stub_id, stub_slug, stub_name, target_id, 'A'::text AS tier
FROM pairs WHERE n_targets = 1;

-- Conflicting evidence is not merged: slug_redirects already sends the stub's slug to a
-- CIF that is neither the target's CIF nor one of the target's alt_cifs / cif_aliases.
DROP TABLE IF EXISTS _tiera_skipped;
CREATE TEMP TABLE _tiera_skipped AS
SELECT a.stub_id, a.stub_slug, a.stub_name, t.cif AS target_cif, t.name AS target_name, r.cif AS redirect_cif
FROM _tiera a
JOIN entities t ON t.id = a.target_id
JOIN slug_redirects r ON r.old_slug = a.stub_slug
WHERE r.cif <> t.cif
  AND NOT (r.cif = ANY (COALESCE(t.alt_cifs, '{}')) OR r.cif = ANY (COALESCE(t.cif_aliases, '{}')));

DROP TABLE IF EXISTS _merge_map;
CREATE TEMP TABLE _merge_map AS
SELECT a.* FROM _tiera a WHERE NOT EXISTS (SELECT 1 FROM _tiera_skipped k WHERE k.stub_id = a.stub_id);

-- ── Tier B candidates: compact-slug twins not already in Tier A ──────
-- Grants/contracts are probed only for the (few) candidates, through the
-- indexed entity_id columns — never a scan of those tables.
DROP TABLE IF EXISTS _tierb;
CREATE TEMP TABLE _tierb AS
WITH stubs AS (
  SELECT e.id, e.slug, e.name, replace(e.slug, '-', '') AS ck
  FROM entities e
  WHERE e.cif IS NULL AND COALESCE(e.total_public_funds, 0) = 0
    AND e.is_anonymized = false AND e.is_person = false
    AND length(replace(e.slug, '-', '')) >= 8
    AND NOT EXISTS (SELECT 1 FROM _merge_map a WHERE a.stub_id = e.id)
),
funded AS (
  SELECT e.id, e.cif, e.total_public_funds, replace(e.slug, '-', '') AS ck
  FROM entities e
  WHERE e.cif IS NOT NULL AND e.total_public_funds > 0
    AND e.is_anonymized = false AND e.is_person = false
    AND length(replace(e.slug, '-', '')) >= 8
),
pairs AS (
  SELECT s.id AS stub_id, s.slug AS stub_slug, s.name AS stub_name,
         COUNT(DISTINCT f.cif) AS n_targets,
         string_agg(DISTINCT f.cif, ',') AS target_cifs,
         (array_agg(f.id ORDER BY f.total_public_funds DESC))[1] AS target_id
  FROM stubs s JOIN funded f ON f.ck = s.ck
  GROUP BY s.id, s.slug, s.name
)
SELECT p.stub_id, p.stub_slug, p.stub_name, p.n_targets, p.target_cifs, p.target_id,
       t.name AS target_name, t.cif AS target_cif,
       r.cif AS redirect_cif,
       (r.cif IS NOT NULL AND r.cif <> t.cif
        AND NOT (r.cif = ANY (COALESCE(t.alt_cifs, '{}')) OR r.cif = ANY (COALESCE(t.cif_aliases, '{}')))) AS redirect_conflict,
       (EXISTS (SELECT 1 FROM grants g    WHERE g.entity_id = p.stub_id)
     OR EXISTS (SELECT 1 FROM contracts c WHERE c.entity_id = p.stub_id)) AS has_rows,
       (t.name ~ '^Empresa [A-Z][0-9A-Z]{8}$'
        OR (length(pg_temp.name_key(p.stub_name)) >= 4 AND length(pg_temp.name_key(t.name)) >= 4
            AND (position(pg_temp.name_key(t.name) in pg_temp.name_key(p.stub_name)) > 0
              OR position(pg_temp.name_key(p.stub_name) in pg_temp.name_key(t.name)) > 0
              OR public.similarity(pg_temp.name_key(p.stub_name), pg_temp.name_key(t.name)) >= 0.5))) AS names_agree
FROM pairs p JOIN entities t ON t.id = p.target_id
LEFT JOIN slug_redirects r ON r.old_slug = p.stub_slug;

ALTER TABLE _tierb ADD COLUMN status text;
UPDATE _tierb SET status = CASE
  WHEN n_targets > 1                                   THEN 'ambiguous'
  WHEN has_rows                                        THEN 'has_grants_or_contracts'
  WHEN NOT names_agree AND :'tierb_name_check' = 'on'  THEN 'name_conflict'
  WHEN redirect_conflict                               THEN 'redirect_conflict'
  ELSE 'merge' END;

INSERT INTO _merge_map (stub_id, stub_slug, stub_name, target_id, tier)
SELECT stub_id, stub_slug, stub_name, target_id, 'B' FROM _tierb WHERE status = 'merge';

-- ── Tier C candidates: stub name extends a TRUNCATED funded name (opt-in merge) ──
-- Join key left(compact,20) prunes the comparison (funded compact >= 25 chars, so the
-- first 20 must agree); starts_with then checks the real prefix relation.
DROP TABLE IF EXISTS _tierc;
CREATE TEMP TABLE _tierc AS
WITH stubs AS (
  SELECT e.id, e.slug, e.name, replace(e.name_norm, ' ', '') AS ck
  FROM entities e
  WHERE e.cif IS NULL AND COALESCE(e.total_public_funds, 0) = 0
    AND e.is_anonymized = false AND e.is_person = false
    AND length(replace(e.name_norm, ' ', '')) > 25
    AND NOT EXISTS (SELECT 1 FROM _merge_map a WHERE a.stub_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM _tierb b WHERE b.stub_id = e.id)
),
trunc AS (
  SELECT e.id, e.cif, e.total_public_funds, replace(e.name_norm, ' ', '') AS ck
  FROM entities e
  WHERE e.cif IS NOT NULL AND e.total_public_funds > 0
    AND e.is_anonymized = false AND e.is_person = false
    AND length(e.name) = 35 AND length(replace(e.name_norm, ' ', '')) >= 25
),
pairs AS (
  SELECT s.id AS stub_id, s.slug AS stub_slug, s.name AS stub_name,
         COUNT(DISTINCT t.cif) AS n_targets,
         string_agg(DISTINCT t.cif, ',') AS target_cifs,
         (array_agg(t.id ORDER BY t.total_public_funds DESC))[1] AS target_id
  FROM stubs s JOIN trunc t
    ON left(t.ck, 20) = left(s.ck, 20) AND length(s.ck) > length(t.ck) AND starts_with(s.ck, t.ck)
  GROUP BY s.id, s.slug, s.name
)
SELECT p.stub_id, p.stub_slug, p.stub_name, p.n_targets, p.target_cifs, p.target_id,
       t.name AS target_name, t.cif AS target_cif,
       r.cif AS redirect_cif,
       (r.cif IS NOT NULL AND r.cif <> t.cif
        AND NOT (r.cif = ANY (COALESCE(t.alt_cifs, '{}')) OR r.cif = ANY (COALESCE(t.cif_aliases, '{}')))) AS redirect_conflict,
       (EXISTS (SELECT 1 FROM grants g    WHERE g.entity_id = p.stub_id)
     OR EXISTS (SELECT 1 FROM contracts c WHERE c.entity_id = p.stub_id)) AS has_rows
FROM pairs p JOIN entities t ON t.id = p.target_id
LEFT JOIN slug_redirects r ON r.old_slug = p.stub_slug;

ALTER TABLE _tierc ADD COLUMN fan_in int, ADD COLUMN status text;
UPDATE _tierc c SET fan_in = f.n
FROM (SELECT target_id, count(*) AS n FROM _tierc WHERE n_targets = 1 GROUP BY target_id) f
WHERE f.target_id = c.target_id AND c.n_targets = 1;
UPDATE _tierc SET status = CASE
  WHEN n_targets > 1                                              THEN 'ambiguous'
  WHEN has_rows                                                   THEN 'has_grants_or_contracts'
  WHEN stub_name LIKE '%||%'                                      THEN 'joint_name'
  WHEN redirect_conflict                                          THEN 'redirect_conflict'
  WHEN fan_in > :tierc_max_stubs                                  THEN 'many_stubs'
  ELSE 'merge' END;

-- 60 random candidates for hand review (SELECTed at the end of the run)
DROP TABLE IF EXISTS _tierc_sample;
CREATE TEMP TABLE _tierc_sample AS
SELECT stub_name, target_name, target_cif, fan_in FROM _tierc WHERE status = 'merge' ORDER BY random() LIMIT 60;

INSERT INTO _merge_map (stub_id, stub_slug, stub_name, target_id, tier)
SELECT stub_id, stub_slug, stub_name, target_id, 'C' FROM _tierc
WHERE status = 'merge' AND :'include_tier_c' = 'on';

CREATE INDEX ON _merge_map (stub_id);
-- Temp tables are never auto-analyzed: without this the planner guesses the row
-- count and may pick a scan of grants/contracts over their entity_id indexes.
ANALYZE _merge_map;

\echo 'Tier A skipped: conflicting redirect:'
SELECT count(*) AS tier_a_skipped_conflicting_redirect FROM _tiera_skipped;
\echo 'pairs to merge by tier:'
SELECT tier, count(*) AS unambiguous_pairs FROM _merge_map GROUP BY tier ORDER BY tier;
\echo 'Tier B candidates by status:'
SELECT status, count(*) FROM _tierb GROUP BY status ORDER BY status;

SELECT (count(*) > 0) AS has_pairs FROM _merge_map
\gset
\if :has_pairs

-- ── backups (reversible) ─────────────────────────────────────────────
-- Include time down to microseconds so same-day reruns get distinct names
-- instead of dropping a legitimate backup from an earlier run.
SELECT to_char(clock_timestamp(), 'YYYYMMDD_HH24MISSUS') AS stub_merge_suffix
\gset

SELECT set_config('menjometre.stub_merge_fk_backup_table', 'stub_merge_fk_bak_' || :'stub_merge_suffix', true);

CREATE TABLE entities_stubmerge_bak_:stub_merge_suffix AS
SELECT e.* FROM entities e JOIN _merge_map u ON u.stub_id = e.id;

CREATE TABLE stub_merge_fk_bak_:stub_merge_suffix (table_name text, fk_column text, stub_id uuid, row_data jsonb);

CREATE TABLE IF NOT EXISTS stub_merge_log_:stub_merge_suffix (
  stub_id uuid, stub_slug text, stub_name text, target_id uuid, merged_at timestamptz DEFAULT now(), tier text);
INSERT INTO stub_merge_log_:stub_merge_suffix (stub_id, stub_slug, stub_name, target_id, tier)
SELECT stub_id, stub_slug, stub_name, target_id, tier FROM _merge_map;

-- Backup and log tables keep row-level security on, as in production, in case the
-- database is ever exposed through an API. (Production also revokes them from its API
-- roles; those roles do not exist in a plain PostgreSQL database.)
ALTER TABLE entities_stubmerge_bak_:stub_merge_suffix ENABLE ROW LEVEL SECURITY;
ALTER TABLE stub_merge_fk_bak_:stub_merge_suffix     ENABLE ROW LEVEL SECURITY;
ALTER TABLE stub_merge_log_:stub_merge_suffix        ENABLE ROW LEVEL SECURITY;

-- ── repoint every FK column + snapshot, set-based with per-row fallback ─
DO $$
DECLARE
  r RECORD;
  rec RECORD;
  fk_backup_table text := current_setting('menjometre.stub_merge_fk_backup_table');
  -- The per-row fallback drops genuinely duplicated stub rows. Count them:
  -- silence here reads the same whether it deleted 0 rows or 400.
  n_del bigint;
  n_esborrades bigint := 0;
  v_big boolean;
  v_ids uuid[] := ARRAY(SELECT stub_id FROM _merge_map);
  n_big bigint;
BEGIN
  FOR r IN
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'entities' AND ccu.column_name = 'id'
      AND tc.table_name <> 'entities'
  LOOP
    -- planner guard: a big table without an index led by the FK column would be
    -- scanned end to end by the set-based statements below. Stop instead.
    v_big := (SELECT c.reltuples FROM pg_class c WHERE c.oid = to_regclass(format('public.%I', r.table_name))) > 1000000;
    IF v_big
       AND NOT EXISTS (
         SELECT 1 FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
         WHERE i.indrelid = to_regclass(format('public.%I', r.table_name))
           AND a.attname = r.column_name AND i.indisvalid)
    THEN
      RAISE EXCEPTION 'refusing to run: %.% has > 1M rows and no valid index led by the FK column', r.table_name, r.column_name;
    END IF;

    -- Big tables (grants ~21-40M rows): never join them to the temp map; the planner can
    -- walk a whole grants index against it for more than ten minutes. Stubs carry no
    -- grants/contracts by construction (candidate filter), so probe ONCE by index with the
    -- id array and skip the snapshot and the repoint when nothing references a stub. If
    -- something does, stop instead of scanning.
    IF v_big THEN
      EXECUTE format('SELECT count(*) FROM public.%I t WHERE t.%I = ANY($1)', r.table_name, r.column_name)
        INTO n_big USING v_ids;
      IF n_big > 0 THEN
        RAISE EXCEPTION 'refusing to run: % row(s) of big table %.% reference a stub that was selected as empty',
          n_big, r.table_name, r.column_name;
      END IF;
      RAISE NOTICE 'big table %.%: no row references a stub (indexed probe); snapshot and repoint skipped',
        r.table_name, r.column_name;
      CONTINUE;
    END IF;

    -- Big tables (grants ~40M rows, contracts ~2.8M): grants.entity_id has an
    -- n_distinct estimate so low that the planner prices ~1,100 stubs at ~18M
    -- matching rows and picks hash join + a full scan of the table, twice (snapshot
    -- and repoint). Force the indexed nested loop there; small tables keep the
    -- default planner (their seq scans are microseconds).
    PERFORM set_config('enable_seqscan',  CASE WHEN v_big THEN 'off' ELSE 'on' END, true);
    PERFORM set_config('enable_hashjoin', CASE WHEN v_big THEN 'off' ELSE 'on' END, true);
    PERFORM set_config('enable_mergejoin', CASE WHEN v_big THEN 'off' ELSE 'on' END, true);

    -- snapshot rows that will be repointed (full row as jsonb, pk-agnostic)
    EXECUTE format(
      'INSERT INTO %I
         SELECT %L, %L, t.%I, to_jsonb(t) FROM public.%I t
         JOIN _merge_map m ON t.%I = m.stub_id',
      fk_backup_table, r.table_name, r.column_name, r.column_name, r.table_name, r.column_name);

    BEGIN
      -- fast path: one set-based repoint for the whole table
      EXECUTE format(
        'UPDATE public.%I t SET %I = m.target_id FROM _merge_map m WHERE t.%I = m.stub_id',
        r.table_name, r.column_name, r.column_name);
    EXCEPTION WHEN unique_violation OR foreign_key_violation THEN
      -- precise per-row fallback (only the colliding table); ctid is stable
      -- within this txn. Repoint where possible, drop redundant stub row on clash.
      FOR rec IN EXECUTE format(
        'SELECT t.ctid AS ct, m.target_id AS tgt
           FROM public.%I t JOIN _merge_map m ON t.%I = m.stub_id',
        r.table_name, r.column_name)
      LOOP
        BEGIN
          EXECUTE format('UPDATE public.%I SET %I = $1 WHERE ctid = $2',
                         r.table_name, r.column_name) USING rec.tgt, rec.ct;
        EXCEPTION WHEN unique_violation OR foreign_key_violation THEN
          EXECUTE format('DELETE FROM public.%I WHERE ctid = $1', r.table_name) USING rec.ct;
          GET DIAGNOSTICS n_del = ROW_COUNT;
          n_esborrades := n_esborrades + n_del;
        END;
      END LOOP;
    END;
  END LOOP;

  PERFORM set_config('enable_seqscan', 'on', true);
  PERFORM set_config('enable_hashjoin', 'on', true);
  PERFORM set_config('enable_mergejoin', 'on', true);

  RAISE NOTICE 'files esborrades per col·lisió: %', n_esborrades;
END $$;

\echo 'FK rows snapshotted:'
SELECT table_name, count(*) FROM stub_merge_fk_bak_:stub_merge_suffix GROUP BY table_name ORDER BY 2 DESC;

-- ── carry clean stub name+slug onto target as searchable aliases ──────
-- also_known_as drives aka_norm through the entities_aka_norm_sync trigger.
WITH agg AS (
  SELECT m.target_id,
         array_agg(s.name) AS names,
         array_agg(s.slug) AS slugs
  FROM _merge_map m
  JOIN entities s ON s.id = m.stub_id
  GROUP BY m.target_id
)
UPDATE entities t SET
  also_known_as = (SELECT array(SELECT DISTINCT x
                    FROM unnest(COALESCE(t.also_known_as,'{}') || a.names) x
                    WHERE x IS NOT NULL AND btrim(x) <> '')),
  slug_aliases  = (SELECT array(SELECT DISTINCT x
                    FROM unnest(COALESCE(t.slug_aliases,'{}') || a.slugs) x
                    WHERE x IS NOT NULL AND btrim(x) <> '')),
  updated_at = NOW()
FROM agg a WHERE t.id = a.target_id;

-- ── the retired URLs keep working: old slug -> CIF of the survivor ────
INSERT INTO slug_redirects (old_slug, cif)
SELECT m.stub_slug, t.cif
FROM _merge_map m JOIN entities t ON t.id = m.target_id
WHERE t.cif IS NOT NULL AND m.stub_slug IS NOT NULL AND m.stub_slug IS DISTINCT FROM t.slug
  AND NOT EXISTS (SELECT 1 FROM slug_redirects r WHERE r.old_slug = m.stub_slug);

-- ── delete the now-merged stubs ──────────────────────────────────────
DELETE FROM entities e USING _merge_map m WHERE e.id = m.stub_id;

-- ── invariants after (abort the transaction on any mismatch) ─────────
DO $$
DECLARE
  b _inv_before%ROWTYPE;
  n_now bigint; s_funds numeric; s_grants numeric; s_contracts numeric;
  n_merged bigint; n_moved_big bigint;
  fk_backup_table text := current_setting('menjometre.stub_merge_fk_backup_table');
BEGIN
  SELECT * INTO b FROM _inv_before;
  SELECT count(*), COALESCE(sum(total_public_funds),0), COALESCE(sum(total_grants),0), COALESCE(sum(total_contracts),0)
    INTO n_now, s_funds, s_grants, s_contracts FROM entities;
  SELECT count(*) INTO n_merged FROM _merge_map;
  EXECUTE format('SELECT count(*) FROM %I WHERE table_name IN (''grants'', ''contracts'')', fk_backup_table)
    INTO n_moved_big;

  IF n_now <> b.n_entities - n_merged THEN
    RAISE EXCEPTION 'invariant: entities % -> % but % stubs merged', b.n_entities, n_now, n_merged;
  END IF;
  IF s_funds <> b.sum_funds OR s_grants <> b.sum_grants OR s_contracts <> b.sum_contracts THEN
    RAISE EXCEPTION 'invariant: sum(total_public_funds/total_grants/total_contracts) changed: % % % -> % % %',
      b.sum_funds, b.sum_grants, b.sum_contracts, s_funds, s_grants, s_contracts;
  END IF;
  IF n_moved_big <> 0 THEN
    RAISE EXCEPTION 'invariant: % grants/contracts rows were attached to merged stubs', n_moved_big;
  END IF;
  RAISE NOTICE 'invariants OK: entities % -> % (merged %), sum(total_public_funds)=%, sum(total_grants)=%, sum(total_contracts)=%, grants/contracts rows moved=0',
    b.n_entities, n_now, n_merged, s_funds, s_grants, s_contracts;
END $$;

\echo 'remaining stub rows that still match a funded twin (should be 0):'
SELECT count(*) FROM _merge_map m JOIN entities e ON e.id = m.stub_id;
\else
\echo 'nothing to merge: no backup tables created, no rows touched'
\endif

-- ── manual review lists (nothing below was merged) ───────────────────
\echo 'MANUAL REVIEW — ambiguous compact slug (more than one funded CIF):'
SELECT stub_slug, stub_name, target_cifs FROM _tierb WHERE status = 'ambiguous' ORDER BY stub_slug;

\echo 'MANUAL REVIEW — stub has grants/contracts (not empty):'
SELECT stub_slug, stub_name, target_cif, target_name FROM _tierb WHERE status = 'has_grants_or_contracts' ORDER BY stub_slug;

\echo 'MANUAL REVIEW — slug agrees but names do not (renamed entity or wrong CIF data):'
SELECT stub_slug, stub_name, target_cif, target_name FROM _tierb WHERE status = 'name_conflict' ORDER BY stub_slug;

\echo 'MANUAL REVIEW — Tier A skipped: conflicting redirect (slug_redirects points the stub slug at another CIF):'
SELECT stub_slug, stub_name, target_cif, redirect_cif, target_name FROM _tiera_skipped ORDER BY stub_slug;

\echo 'MANUAL REVIEW — Tier B skipped: conflicting redirect (slug_redirects points the stub slug at another CIF):'
SELECT stub_slug, stub_name, target_cif, redirect_cif, target_name FROM _tierb WHERE status = 'redirect_conflict' ORDER BY stub_slug;

-- ── Tier C report (merged only with -v include_tier_c=on; this run: :include_tier_c) ──
\echo 'TIER C (truncated-name prefix) candidates by status  [include_tier_c=' :include_tier_c ', tierc_max_stubs=' :tierc_max_stubs ']:'
SELECT status, count(*) AS stubs, count(DISTINCT target_id) AS targets FROM _tierc GROUP BY status ORDER BY status;

\echo 'TIER C sample — 60 random merge candidates (stub_name | target_name | target_cif | stubs on that target):'
SELECT stub_name, target_name, target_cif, fan_in FROM _tierc_sample;

\echo 'MANUAL REVIEW (Tier C) — many stubs extend one truncated target (different entities may share a 35-char prefix):'
SELECT target_cif, target_name, fan_in AS stubs FROM _tierc WHERE status = 'many_stubs' GROUP BY target_cif, target_name, fan_in ORDER BY fan_in DESC;

\echo 'MANUAL REVIEW (Tier C) — skipped: conflicting redirect:'
SELECT stub_slug, stub_name, target_cif, redirect_cif, target_name FROM _tierc WHERE status = 'redirect_conflict' ORDER BY stub_slug;

\echo 'MANUAL REVIEW (Tier C) — stub has grants/contracts:'
SELECT stub_slug, stub_name, target_cif, target_name FROM _tierc WHERE status = 'has_grants_or_contracts' ORDER BY stub_slug;
