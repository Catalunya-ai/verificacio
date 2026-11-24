-- =====================================================================
-- Extensions and the text helper the tables need.
--
-- gen_random_uuid() is built into PostgreSQL 13+. unaccent and pg_trgm are
-- standard contrib extensions (package postgresql-contrib on most systems):
-- slugify_organ() uses unaccent, and the stub reconciliation
-- (sql/pipeline/020-reconcile-entity-stubs.sql) uses similarity() from pg_trgm.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Source: production schema. Immutable wrapper so it
-- can back the generated column entities.name_norm.
CREATE OR REPLACE FUNCTION public.immutable_unaccent(input text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS
$$SELECT public.unaccent('public.unaccent', input)$$;
