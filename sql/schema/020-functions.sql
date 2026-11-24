-- =====================================================================
-- Helper functions: organ slugs for the materialised views, and the merge
-- of an empty duplicate entity into its funded twin (entity resolution).
--
-- Copied verbatim from the production schema.
-- =====================================================================

-- Source: production schema
CREATE OR REPLACE FUNCTION slugify_organ(input TEXT)
RETURNS TEXT LANGUAGE sql STABLE STRICT
SET search_path = ''
AS $$
  SELECT regexp_replace(        -- level 1 (outermost): strip leading/trailing hyphens
    regexp_replace(             -- level 2: non-alphanumeric → hyphen
    regexp_replace(             -- level 3: SC suffix
    regexp_replace(             -- level 4: SL suffix
    regexp_replace(             -- level 5: SA suffix
    regexp_replace(             -- level 6: SCP suffix
    regexp_replace(             -- level 7: SCCL suffix
    regexp_replace(             -- level 8: SLU suffix
    regexp_replace(             -- level 9: SAU suffix
    regexp_replace(             -- level 10: ASSOC
    regexp_replace(             -- level 11: HOSP
    regexp_replace(             -- level 12: INST
    regexp_replace(             -- level 13: UNIV
    regexp_replace(             -- level 14: FUND
    regexp_replace(             -- level 15: CONS
    regexp_replace(             -- level 16: DIPUT
    regexp_replace(             -- level 17: AJ (must come after AJUNT)
    regexp_replace(             -- level 18 (innermost): AJUNT
      upper(public.unaccent(input)),
      E'\\mAJUNT\\M\\.?\\s*', 'AJUNTAMENT ', 'g'),
      E'\\mAJ\\M\\.?\\s*', 'AJUNTAMENT ', 'g'),
      E'\\mDIPUT\\M\\.?\\s*', 'DIPUTACIO ', 'g'),
      E'\\mCONS\\M\\.?\\s*', 'CONSORCI ', 'g'),
      E'\\mFUND\\M\\.?\\s*', 'FUNDACIO ', 'g'),
      E'\\mUNIV\\M\\.?\\s*', 'UNIVERSITAT ', 'g'),
      E'\\mINST\\M\\.?\\s*', 'INSTITUT ', 'g'),
      E'\\mHOSP\\M\\.?\\s*', 'HOSPITAL ', 'g'),
      E'\\mASSOC\\M\\.?\\s*', 'ASSOCIACIO ', 'g'),
      E'\\mS\\.?\\s*A\\.?\\s*U\\M\\.?', 'SAU', 'g'),
      E'\\mS\\.?\\s*L\\.?\\s*U\\M\\.?', 'SLU', 'g'),
      E'\\mS\\.?\\s*C\\.?\\s*C\\.?\\s*L\\M\\.?', 'SCCL', 'g'),
      E'\\mS\\.?\\s*C\\.?\\s*P\\M\\.?', 'SCP', 'g'),
      E'\\mS\\.?\\s*A\\M\\.?', 'SA', 'g'),
      E'\\mS\\.?\\s*L\\M\\.?', 'SL', 'g'),
      E'\\mS\\.?\\s*C\\M\\.?', 'SC', 'g'),
      '[^A-Z0-9]+', '-', 'g'),
    '^-|-$', '', 'g')
$$;

-- Source: production schema
-- Folds an empty duplicate "stub" entity into its canonical funded twin: repoints
-- every foreign key, keeps the stub name and slug as aliases, records the old
-- slug in slug_redirects and deletes the stub. Used by
-- sql/pipeline/030-reconcile-curated-aliases.sql.
CREATE OR REPLACE FUNCTION public.merge_entity_stub(p_stub uuid, p_target uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  r RECORD;
  v_name text;
  v_slug text;
  v_tcif text;
  v_tslug text;
BEGIN
  IF p_stub IS NULL OR p_target IS NULL OR p_stub = p_target THEN
    RETURN;
  END IF;

  SELECT name, slug INTO v_name, v_slug FROM public.entities WHERE id = p_stub;
  IF NOT FOUND THEN
    RETURN;  -- stub already merged/removed
  END IF;

  SELECT cif, slug INTO v_tcif, v_tslug FROM public.entities WHERE id = p_target;
  IF NOT FOUND THEN
    RETURN;  -- unknown target: repointing would fail and the fallback would delete stub rows
  END IF;

  -- Repoint every FK column referencing entities.id
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
    BEGIN
      EXECUTE format('UPDATE public.%I SET %I = $1 WHERE %I = $2',
                     r.table_name, r.column_name, r.column_name)
        USING p_target, p_stub;
    EXCEPTION WHEN unique_violation OR foreign_key_violation THEN
      -- target already holds the canonical row(s); stub's are redundant
      EXECUTE format('DELETE FROM public.%I WHERE %I = $1', r.table_name, r.column_name)
        USING p_stub;
    END;
  END LOOP;

  -- Preserve clean name + slug as aliases on the target so search can find it
  UPDATE public.entities t SET
    also_known_as = (
      SELECT array(SELECT DISTINCT x
                   FROM unnest(COALESCE(t.also_known_as, '{}') || ARRAY[v_name]) x
                   WHERE x IS NOT NULL AND btrim(x) <> '')),
    slug_aliases = (
      SELECT array(SELECT DISTINCT x
                   FROM unnest(COALESCE(t.slug_aliases, '{}') || ARRAY[v_slug]) x
                   WHERE x IS NOT NULL AND btrim(x) <> '')),
    aka_norm = regexp_replace(
      upper(public.immutable_unaccent(
        array_to_string(
          (SELECT array(SELECT DISTINCT x
                        FROM unnest(COALESCE(t.also_known_as, '{}') || ARRAY[v_name]) x
                        WHERE x IS NOT NULL AND btrim(x) <> '')), ' '))),
      '[^A-Z0-9 ]+', ' ', 'g'),
    updated_at = NOW()
  WHERE t.id = p_target;

  -- The retired URL keeps working: old slug -> CIF of the surviving entity.
  IF v_tcif IS NOT NULL AND v_slug IS NOT NULL AND v_slug IS DISTINCT FROM v_tslug THEN
    -- NOT EXISTS instead of ON CONFLICT (old_slug): it also works on a slug_redirects table
    -- created without its primary key.
    INSERT INTO public.slug_redirects (old_slug, cif)
    SELECT v_slug, v_tcif
    WHERE NOT EXISTS (SELECT 1 FROM public.slug_redirects sr WHERE sr.old_slug = v_slug);
  END IF;

  DELETE FROM public.entities WHERE id = p_stub;
END $function$;
