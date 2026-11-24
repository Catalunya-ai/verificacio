-- =====================================================================
-- Creates everything the pipeline needs in an empty PostgreSQL database.
--
-- Run it from the repository root (the \i paths are relative to it):
--
--   npx tsx src/pipeline/run-sql.ts sql/install.sql
--
-- Every statement is CREATE ... IF NOT EXISTS, CREATE OR REPLACE or an
-- INSERT ... ON CONFLICT DO NOTHING: the file can be run again.
-- =====================================================================

\set ON_ERROR_STOP on

\i sql/schema/000-extensions.sql
\i sql/schema/010-tables.sql
\i sql/schema/020-functions.sql
\i sql/schema/030-contract-dedup.sql
\i sql/curation/010-contract-expedient-aliases.sql
\i sql/matviews/010-contract-yearly-stats.sql
\i sql/matviews/020-yearly-totals.sql
\i sql/matviews/030-grant-organs.sql
