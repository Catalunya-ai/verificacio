-- Same SQL as the production step, except the final check. 14 hand-checked rows, every one an organisation (CIF G, Q or P)
-- and its own name variants; no row names a person. The final check lists
-- the aliases.
-- Run inside a single transaction:
--   npx tsx src/pipeline/run-sql.ts sql/pipeline/030-reconcile-curated-aliases.sql --single-transaction
-- =====================================================================
-- reconcile-curated-aliases.sql — HUMAN-VERIFIED allowlist for entity
-- name variants that fuzzy matching cannot resolve safely (abbreviations,
-- dropped articles), so each row here is checked by a person.
--
-- Two kinds of entry:
--   * stub_slug present  → fold that empty stub into the target CIF
--                          (merge_entity_stub: repoint FKs + alias + delete)
--   * stub_slug NULL      → just register the clean name as an alias on the
--                          target CIF (also_known_as / aka_norm), so the
--                          search can find it.
--
-- Idempotent. Safe to re-run. Add new VERIFIED rows over time.
-- =====================================================================
\pset pager off

DROP TABLE IF EXISTS _curated;
CREATE TEMP TABLE _curated (target_cif text, clean_name text, stub_slug text);

-- ── VERIFIED ENTRIES ─────────────────────────────────────────────────
-- Premsa / periodisme
INSERT INTO _curated (target_cif, clean_name, stub_slug) VALUES
  -- Associació Catalana de la Premsa Comarcal (G58010315): empty duplicate + abbreviated name
  ('G58010315', 'Associació Catalana de la Premsa Comarcal', 'ASSOCIACIO-CATALANA-DE-LA-PREMSA-COMARCAL'),
  ('G58010315', 'Associació Catalana de la Premsa Comarcal', 'AS-CAT-DE-PREMSA-COMARCAL'),
  -- Sindicat de Periodistes de Catalunya (G60369931): clean-name twin + alias
  ('G60369931', 'Sindicat de Periodistes de Catalunya', 'SINDICAT-DE-PERIODISTES-DE-CATALUNYA'),
  ('G60369931', 'Sindicat de Periodistes de Catalunya', NULL),
  -- Grup de Periodistes Ramon Barnils (G62896196): funded name truncated to
  --   "...BARN"; fold the no-article twin and register the full name.
  ('G62896196', 'Grup de Periodistes Ramon Barnils', 'GRUP-PERIODISTES-RAMON-BARNILS'),
  ('G62896196', 'Grup de Periodistes Ramon Barnils', NULL),
  -- Associació de Dones Periodistes de Catalunya (G60098241)
  ('G60098241', 'Associació de Dones Periodistes de Catalunya', 'ASSOCIACIO-DE-DONES-PERIODISTES-DE-CATALUNYA'),
  -- Col·legi de Periodistes de Catalunya (Q5856081D): two spelling twins
  ('Q5856081D', 'Col·legi de Periodistes de Catalunya', 'COL-LEGI-PERIODISTES-DE-CATALUNYA'),
  ('Q5856081D', 'Col·legi de Periodistes de Catalunya', 'COLLEGI-DE-PERIODISTES-DE-CATALUNYA');

-- Tercer sector / habitatge
INSERT INTO _curated (target_cif, clean_name, stub_slug) VALUES
  -- Fundació Privada Hàbitat3 Tercer Sector Social (G66428681): CIF verified from the
  -- foundation's own transparency page. The funded record carries the name cut to 35
  -- chars ("FUNDACIÓ PRIVADA HABITAT 3 TERCER S"). Public names go in as aliases; the two
  -- CIF-less stubs seen in the data are folded in (a no-op wherever a stub is absent
  -- — e.g. already merged by reconcile-entity-stubs.sql Tier B, or never ingested).
  ('G66428681', 'Fundació Hàbitat3', NULL),
  ('G66428681', 'Hàbitat3', NULL),
  ('G66428681', 'Fundació Privada Hàbitat3 Tercer Sector Social', 'FUNDACIO-PRIVADA-HABITAT3-TERCER-SECTOR-SOCIAL'),
  ('G66428681', 'Fundació Privada Hàbitat3 Tercer Sector Social', 'FUNDACIO-PRIVADA-HABITAT-3-TERCER-SECTOR');

-- Ajuntaments: the council's CIF row carries the label its organ contracts under, so a search for that label
-- reaches the CIF row by its alias. Aliases only (stub_slug NULL): no row is folded or deleted. One row per
-- reviewed example: (CIF of the council row, organ label exactly as the contracts publish it, NULL).
INSERT INTO _curated (target_cif, clean_name, stub_slug) VALUES
  ('P0810000J', 'Ajuntament de l''Hospitalet de Llobregat', NULL);

-- ── candidate pairs ──────────────────────────────────────────────────
DROP TABLE IF EXISTS _merge_map;
CREATE TEMP TABLE _merge_map AS
SELECT
  s.id AS stub_id,
  s.slug AS stub_slug,
  s.name AS stub_name,
  t.id AS target_id,
  c.target_cif
FROM _curated c
JOIN public.entities t ON t.cif = c.target_cif
JOIN public.entities s ON s.slug = c.stub_slug AND s.cif IS NULL
WHERE c.stub_slug IS NOT NULL
  AND s.id <> t.id;

CREATE INDEX ON _merge_map (stub_id);
-- Temp tables are never auto-analyzed; without stats the planner may price the FK
-- snapshot below as a hash join over a full scan of grants (~40M rows).
ANALYZE _merge_map;
\echo 'curated stub pairs to merge:'
SELECT count(*) AS curated_pairs FROM _merge_map;

SELECT (count(*) > 0) AS has_pairs FROM _merge_map
\gset
\if :has_pairs

-- ── backups (reversible) ─────────────────────────────────────────────
-- Same dated suffix pattern as 020-reconcile-entity-stubs.sql: a rerun creates
-- a separate safety copy instead of overwriting a previous restore point.
SELECT to_char(clock_timestamp(), 'YYYYMMDD_HH24MISSUS') AS stub_merge_suffix
\gset

SELECT set_config('menjometre.stub_merge_fk_backup_table', 'stub_merge_fk_bak_' || :'stub_merge_suffix', true);

CREATE TABLE entities_stubmerge_bak_:stub_merge_suffix AS
SELECT e.* FROM public.entities e JOIN _merge_map u ON u.stub_id = e.id;

CREATE TABLE stub_merge_fk_bak_:stub_merge_suffix (table_name text, fk_column text, stub_id uuid, row_data jsonb);

CREATE TABLE IF NOT EXISTS stub_merge_log_:stub_merge_suffix (
  stub_id uuid, stub_slug text, stub_name text, target_id uuid, merged_at timestamptz DEFAULT now());
INSERT INTO stub_merge_log_:stub_merge_suffix (stub_id, stub_slug, stub_name, target_id)
SELECT stub_id, stub_slug, stub_name, target_id FROM _merge_map;

-- Snapshot every FK row before merge_entity_stub can repoint or delete it.
DO $$
DECLARE
  r RECORD;
  fk_backup_table text := current_setting('menjometre.stub_merge_fk_backup_table');
  v_big boolean;
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
    -- big tables (grants, contracts): force the indexed nested loop over the few stubs
    v_big := (SELECT c.reltuples FROM pg_class c WHERE c.oid = to_regclass(format('public.%I', r.table_name))) > 1000000;
    PERFORM set_config('enable_seqscan',   CASE WHEN v_big THEN 'off' ELSE 'on' END, true);
    PERFORM set_config('enable_hashjoin',  CASE WHEN v_big THEN 'off' ELSE 'on' END, true);
    PERFORM set_config('enable_mergejoin', CASE WHEN v_big THEN 'off' ELSE 'on' END, true);
    EXECUTE format(
      'INSERT INTO %I
         SELECT %L, %L, t.%I, to_jsonb(t) FROM public.%I t
         JOIN _merge_map m ON t.%I = m.stub_id',
      fk_backup_table, r.table_name, r.column_name, r.column_name, r.table_name, r.column_name);
  END LOOP;
  PERFORM set_config('enable_seqscan', 'on', true);
  PERFORM set_config('enable_hashjoin', 'on', true);
  PERFORM set_config('enable_mergejoin', 'on', true);
END $$;

\echo 'curated FK rows snapshotted:'
SELECT table_name, count(*) FROM stub_merge_fk_bak_:stub_merge_suffix GROUP BY table_name ORDER BY 2 DESC;

-- ── apply stub merges (where a stub_slug is given) ───────────────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM _merge_map LOOP
    PERFORM public.merge_entity_stub(r.stub_id, r.target_id);
    RAISE NOTICE 'merged % -> %', r.stub_slug, r.target_cif;
  END LOOP;
END $$;

\else
\echo 'no curated stub to merge: no backup tables created'
\endif

-- ── register clean names as aliases on every target (covers both kinds) ─
-- merge_entity_stub already added the stub name; this also covers the
-- NULL-stub rows and guarantees the canonical clean_name is present.
WITH agg AS (
  SELECT target_cif, array_agg(clean_name) AS names FROM _curated GROUP BY target_cif
)
UPDATE public.entities t SET
  also_known_as = (SELECT array(SELECT DISTINCT x
                    FROM unnest(COALESCE(t.also_known_as,'{}') || a.names) x
                    WHERE x IS NOT NULL AND btrim(x) <> '')),
  aka_norm = regexp_replace(
    upper(public.immutable_unaccent(
      array_to_string(
        (SELECT array(SELECT DISTINCT x
                      FROM unnest(COALESCE(t.also_known_as,'{}') || a.names) x
                      WHERE x IS NOT NULL AND btrim(x) <> '')), ' '))),
    '[^A-Z0-9 ]+', ' ', 'g'),
  updated_at = NOW()
FROM agg a WHERE t.cif = a.target_cif;

\echo 'targets and their registered aliases:'
SELECT c.target_cif, t.name, t.also_known_as
FROM (SELECT DISTINCT target_cif FROM _curated) c
JOIN public.entities t ON t.cif = c.target_cif
ORDER BY 1;
