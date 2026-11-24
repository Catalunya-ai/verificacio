-- =====================================================================
-- Contract deduplication: expedient aliases and official annulments.
--
-- The open-data source sometimes publishes one award under two expedient
-- codes, and it keeps the lines of awards the organ later annulled. These
-- tables and functions keep those rows from counting twice (aliases) or from
-- counting as awards at all (annulments). aggregate-stats.ts and
-- sync-contractes.ts call detect_contract_expedient_aliases() and
-- apply_contract_annulments(); sync-contract-annulments.ts loads the official
-- annulment lines and calls decide_contract_annulments() and
-- decide_contract_annulment_checks().
--
-- Each definition below is the final version in the production schema,
-- copied verbatim. Grants to hosted-platform roles were left out.
-- =====================================================================

-- Source: production schema
CREATE TABLE IF NOT EXISTS public.contract_expedient_aliases (
  organ                    text        NOT NULL,
  alias_codi_expedient     text        NOT NULL,
  canonical_codi_expedient text        NOT NULL,
  reason                   text        NOT NULL,
  added_on                 date        NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (organ, alias_codi_expedient),
  CHECK (alias_codi_expedient <> canonical_codi_expedient)
);

-- Source: production schema (final form of the rule column and its CHECK).
ALTER TABLE public.contract_expedient_aliases
  ADD COLUMN IF NOT EXISTS rule text NOT NULL DEFAULT 'curated';
ALTER TABLE public.contract_expedient_aliases
  DROP CONSTRAINT IF EXISTS contract_expedient_aliases_rule_check;
ALTER TABLE public.contract_expedient_aliases
  ADD CONSTRAINT contract_expedient_aliases_rule_check
  CHECK (rule IN ('curated', 'auto_code_format', 'auto_phase', 'rejected'));

-- Source: production schema
-- 2. Helpers.
CREATE OR REPLACE FUNCTION public.contract_expedient_norm(p_code text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path = public
AS $function$
  SELECT upper(regexp_replace(p_code, '[^A-Za-z0-9]', '', 'g'))
$function$;

-- Source: production schema
CREATE OR REPLACE FUNCTION public.contract_expedient_key(p_code text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path = public
AS $function$
  SELECT CASE
           WHEN length(k.v) >= 5 AND k.v ~ '[0-9]' THEN k.v
           WHEN length(k.n) >= 5 AND k.n ~ '[0-9]' THEN k.n
         END
    FROM (SELECT q.n, regexp_replace(q.n, '^[A-Z]+([0-9])', '\1') AS v
            FROM (SELECT public.contract_expedient_norm(p_code) AS n) q) k
$function$;

-- Source: production schema
-- True when p_long is p_short plus a phase marker. p_d1 / p_d2 are the descriptions of the two rows,
-- in any order of relevance: either one saying "segona fase" is enough for a bare numeric suffix.
CREATE OR REPLACE FUNCTION public.contract_expedient_phase_suffix(p_short text, p_long text, p_d1 text, p_d2 text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path = public
AS $function$
  SELECT COALESCE(
           n.s IS NOT NULL AND n.l IS NOT NULL
           AND length(n.s) >= 5
           AND left(n.l, length(n.s)) = n.s
           AND (
             n.r ~ '^(FASE([0-9]{1,2}|FINAL)|[0-9]{1,2}A?RONDA|BIS)$'
             OR (n.r ~ '^[0-9]{1,2}$'
                 AND (COALESCE(p_d1, '') ~* '(segona|2a|2ª)\s+fase|fase\s*(2|ii)\M'
                      OR COALESCE(p_d2, '') ~* '(segona|2a|2ª)\s+fase|fase\s*(2|ii)\M'))
           ),
           false)
    FROM (
      SELECT q.s, q.l, substr(q.l, length(q.s) + 1) AS r
        FROM (SELECT public.contract_expedient_norm(p_short) AS s,
                     public.contract_expedient_norm(p_long) AS l) q
    ) n
$function$;

-- Source: production schema
-- 2. Helper. The letter prefix that key()
-- removes from a code; empty when there is none, and empty when key() uses the whole normalised
-- code because the stripped form was too short (the same two conditions as key()).
CREATE OR REPLACE FUNCTION public.contract_expedient_prefix(p_code text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path = public
AS $function$
  SELECT CASE
           WHEN length(k.v) >= 5 AND k.v ~ '[0-9]' THEN COALESCE(substring(k.n from '^[A-Z]+(?=[0-9])'), '')
           ELSE ''
         END
    FROM (SELECT q.n, regexp_replace(q.n, '^[A-Z]+([0-9])', '\1') AS v
            FROM (SELECT public.contract_expedient_norm(p_code) AS n) q) k
$function$;

-- Source: production schema
-- 3. Trigger function. A row under an alias expedient is written as superseded only when the canonical
-- expedient has a live twin, and rows of rule 'rejected' are not aliases. Two lookups, one per partial
-- unique index: uq_contract_v2_cif (codi_expedient, cif, lot_number) with a cif, uq_contract_v2_slug
-- (codi_expedient, entity_slug, lot_number) without it. The trigger definition does not change.
CREATE OR REPLACE FUNCTION public.contracts_enforce_expedient_alias()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_canonical text;
  v_twin      boolean := false;
BEGIN
  IF NEW.superseded IS NOT TRUE THEN
    SELECT a.canonical_codi_expedient INTO v_canonical
      FROM public.contract_expedient_aliases a
     WHERE a.organ = NEW.organ
       AND a.alias_codi_expedient = NEW.codi_expedient
       AND a.rule <> 'rejected';

    IF FOUND THEN
      IF NEW.cif IS NOT NULL AND NEW.cif <> '' THEN
        SELECT EXISTS (
          SELECT 1 FROM public.contracts t
           WHERE t.codi_expedient = v_canonical
             AND t.cif = NEW.cif AND t.cif <> ''
             AND (t.lot_number = NEW.lot_number OR coalesce(NEW.lot_number, '') = '' OR coalesce(t.lot_number, '') = '')
             AND t.organ = NEW.organ
             AND t.amount = NEW.amount
             AND t.superseded IS NOT TRUE) INTO v_twin;
      ELSE
        SELECT EXISTS (
          SELECT 1 FROM public.contracts t
           WHERE t.codi_expedient = v_canonical
             AND (t.cif IS NULL OR t.cif = '')
             AND t.entity_slug = NEW.entity_slug
             AND (t.lot_number = NEW.lot_number OR coalesce(NEW.lot_number, '') = '' OR coalesce(t.lot_number, '') = '')
             AND t.organ = NEW.organ
             AND t.amount = NEW.amount
             AND t.superseded IS NOT TRUE) INTO v_twin;
      END IF;

      IF v_twin THEN
        NEW.superseded := true;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- Source: production schema
CREATE OR REPLACE TRIGGER trg_contracts_enforce_expedient_alias
  BEFORE INSERT OR UPDATE OF superseded, organ, codi_expedient ON public.contracts
  FOR EACH ROW
  WHEN (NEW.superseded IS NOT TRUE)
  EXECUTE FUNCTION public.contracts_enforce_expedient_alias();

-- Source: production schema
-- 4. Detection. Without p_organ it reads the whole table: call it from the pipeline, never from a
-- test and never from this file. Same signature and return type as before; changes: the prefix
-- guard of auto_code_format (fmt_first, fmt_mixed, fmt_cls, fmt_canon, fmt_edges) and the rows of
-- rule 'rejected' (not read as aliases by the chain resolution m, not superseded by step d).
CREATE OR REPLACE FUNCTION public.detect_contract_expedient_aliases(p_organ text DEFAULT NULL)
 RETURNS TABLE (aliases_added integer, rows_superseded integer)
 LANGUAGE plpgsql
 SET search_path = public
 SET plan_cache_mode = force_custom_plan
AS $function$
DECLARE
  v_self    integer;
  v_chained integer;
  v_rows    integer;
BEGIN
  aliases_added := 0;
  rows_superseded := 0;

  PERFORM pg_advisory_xact_lock(hashtext('contract_dedup'));

  -- a-c. Candidate groups, edges alias -> canonical, chain resolution and insert, in one statement.
  WITH RECURSIVE
  -- Stage 1, CIF branch: groups by (organ, cif, amount, date), without the lot. Only the columns of
  -- idx_contracts_dedup_secondary, so the whole-table pass is an index-only scan. Two live rows with
  -- the same cif and lot never share a codi_expedient (uq_contract_v2_cif), so a repeated lot value
  -- means two different codes; an empty lot next to another row can pair with it whatever its lot.
  g_cif AS (
    SELECT organ, cif, amount, contract_date
      FROM public.contracts
     WHERE superseded IS NOT TRUE AND amount > 0
       AND cif IS NOT NULL AND cif <> ''
       AND organ IS NOT NULL AND organ <> ''
       AND contract_date IS NOT NULL
       AND (p_organ IS NULL OR organ = p_organ)
     GROUP BY organ, cif, amount, contract_date
    HAVING count(*) > count(DISTINCT lot_number)
        OR (count(*) > 1 AND bool_or(coalesce(lot_number, '') = ''))
  ),
  -- Stage 1, no-CIF branch: identity is entity_slug.
  g_slug AS (
    SELECT organ, entity_slug, amount, contract_date
      FROM public.contracts
     WHERE superseded IS NOT TRUE AND amount > 0 AND codi_expedient IS NOT NULL
       AND (cif IS NULL OR cif = '')
       AND entity_slug IS NOT NULL
       AND organ IS NOT NULL AND organ <> ''
       AND contract_date IS NOT NULL
       AND (p_organ IS NULL OR organ = p_organ)
     GROUP BY organ, entity_slug, amount, contract_date
    HAVING count(DISTINCT codi_expedient) > 1
  ),
  -- Stage 2: one row per (group, row) with its code, lot and description, read back through the indexes.
  r_cif AS (
    SELECT g.gid, c.organ, c.code, c.lot_number, c.description, c.id
      FROM (SELECT x.*, 'c' || dense_rank() OVER (ORDER BY x.organ, x.cif, x.amount, x.contract_date) AS gid
              FROM g_cif x) g
     CROSS JOIN LATERAL (
       SELECT c.organ, c.codi_expedient AS code, c.lot_number, c.description, c.id
         FROM public.contracts c
        WHERE c.cif = g.cif AND c.amount = g.amount AND c.contract_date = g.contract_date
          AND c.organ = g.organ
          AND c.superseded IS NOT TRUE AND c.cif <> '' AND c.amount > 0
          AND c.organ <> '' AND c.codi_expedient IS NOT NULL
        OFFSET 0) c
  ),
  r_slug AS (
    SELECT g.gid, c.organ, c.code, c.lot_number, c.description, c.id
      FROM (SELECT x.*, 's' || dense_rank() OVER (ORDER BY x.organ, x.entity_slug, x.amount, x.contract_date) AS gid
              FROM g_slug x) g
     CROSS JOIN LATERAL (
       SELECT c.organ, c.codi_expedient AS code, c.lot_number, c.description, c.id
         FROM public.contracts c
        WHERE c.entity_slug = g.entity_slug AND c.amount = g.amount AND c.contract_date = g.contract_date
          AND c.organ = g.organ
          AND c.superseded IS NOT TRUE AND (c.cif IS NULL OR c.cif = '') AND c.amount > 0
          AND c.codi_expedient IS NOT NULL
        OFFSET 0) c
  ),
  cand AS (
    SELECT gid, organ, code, lot_number, description, id FROM r_cif
    UNION ALL
    SELECT gid, organ, code, lot_number, description, id FROM r_slug
  ),
  -- Each pair of distinct codes inside a group with compatible lots. A code pair can appear once per
  -- compatible pair of rows; the later steps do not depend on that.
  pairs AS (
    SELECT a.organ, a.code AS code_a, b.code AS code_b, a.id AS id_a, b.id AS id_b,
           a.description AS d_a, b.description AS d_b
      FROM cand a
      JOIN cand b ON a.gid = b.gid AND a.code < b.code
                 AND (b.lot_number = a.lot_number OR coalesce(a.lot_number, '') = '' OR coalesce(b.lot_number, '') = '')
  ),
  -- auto_code_format: the codes that share a non-null key with another code of the group, per
  -- (organ, key); the canonical code is the one with the smallest first row.
  fmt_codes AS (
    SELECT organ, public.contract_expedient_key(code_a) AS k, code_a AS code, id_a AS id
      FROM pairs
     WHERE public.contract_expedient_key(code_a) IS NOT NULL
       AND public.contract_expedient_key(code_a) = public.contract_expedient_key(code_b)
    UNION ALL
    SELECT organ, public.contract_expedient_key(code_b), code_b, id_b
      FROM pairs
     WHERE public.contract_expedient_key(code_a) IS NOT NULL
       AND public.contract_expedient_key(code_a) = public.contract_expedient_key(code_b)
  ),
  fmt_first AS (
    SELECT organ, k, code, public.contract_expedient_prefix(code) AS pfx,
           (array_agg(id ORDER BY id))[1] AS first_id
      FROM fmt_codes
     GROUP BY organ, k, code
  ),
  -- Prefix guard. Two codes of a class may merge only when their letter prefixes are equal or one
  -- of them is empty. Equality of prefixes is transitive, "one is empty" is not, so a class (organ,
  -- key) that holds two or more different non-empty prefixes is split by prefix, and its codes with
  -- an empty prefix are left alone. A class with at most one non-empty prefix is not split.
  fmt_mixed AS (
    SELECT organ, k
      FROM fmt_first
     WHERE pfx <> ''
     GROUP BY organ, k
    HAVING count(DISTINCT pfx) >= 2
  ),
  fmt_cls AS (
    SELECT f.organ, f.k, f.code, f.first_id,
           CASE WHEN x.k IS NULL THEN '' ELSE f.pfx END AS cls
      FROM fmt_first f
      LEFT JOIN fmt_mixed x ON x.organ = f.organ AND x.k = f.k
     WHERE x.k IS NULL OR f.pfx <> ''
  ),
  fmt_canon AS (
    SELECT DISTINCT ON (organ, k, cls) organ, k, cls, code AS canonical
      FROM fmt_cls
     ORDER BY organ, k, cls, first_id
  ),
  fmt_edges AS (
    SELECT f.organ, f.code AS alias, c.canonical, 'auto_code_format'::text AS rule
      FROM fmt_cls f
      JOIN fmt_canon c ON c.organ = f.organ AND c.k = f.k AND c.cls = f.cls AND c.canonical <> f.code
  ),
  -- auto_phase: alias = the long code, canonical = the short code, in either order of the pair.
  phase_edges AS (
    SELECT organ, code_b AS alias, code_a AS canonical, 'auto_phase'::text AS rule
      FROM pairs
     WHERE public.contract_expedient_phase_suffix(code_a, code_b, d_a, d_b)
    UNION ALL
    SELECT organ, code_a, code_b, 'auto_phase'::text
      FROM pairs
     WHERE public.contract_expedient_phase_suffix(code_b, code_a, d_b, d_a)
  ),
  -- One edge per (organ, alias); the format rule wins over the phase rule.
  e0 AS (
    SELECT DISTINCT ON (organ, alias) organ, alias, canonical, rule
      FROM (SELECT organ, alias, canonical, rule, 1 AS pri FROM fmt_edges
            UNION ALL
            SELECT organ, alias, canonical, rule, 2 AS pri FROM phase_edges) u
     ORDER BY organ, alias, pri, canonical
  ),
  -- Every known alias -> canonical, the existing table first. A rejected row says two codes are NOT
  -- the same award, so it is not an alias and no chain runs through it.
  m AS (
    SELECT DISTINCT ON (organ, alias) organ, alias, canonical
      FROM (SELECT organ, alias_codi_expedient AS alias, canonical_codi_expedient AS canonical, 0 AS pri
              FROM public.contract_expedient_aliases
             WHERE (p_organ IS NULL OR organ = p_organ) AND rule <> 'rejected'
            UNION ALL
            SELECT organ, alias, canonical, 1 AS pri FROM e0) u
     ORDER BY organ, alias, pri
  ),
  -- Chain resolution: while the canonical of an edge is itself an alias, point at that alias's
  -- canonical, at most 3 times.
  walk(organ, alias, canonical, rule, depth) AS (
    SELECT organ, alias, canonical, rule, 0 FROM e0
    UNION ALL
    SELECT w.organ, w.alias, m.canonical, w.rule, w.depth + 1
      FROM walk w
      JOIN m ON m.organ = w.organ AND m.alias = w.canonical
     WHERE w.depth < 3
  ),
  resolved AS (
    SELECT DISTINCT ON (organ, alias) organ, alias, canonical, rule
      FROM walk
     ORDER BY organ, alias, depth DESC
  ),
  classified AS (
    SELECT r.organ, r.alias, r.canonical, r.rule,
           (r.canonical = r.alias) AS is_self,
           EXISTS (SELECT 1 FROM m WHERE m.organ = r.organ AND m.alias = r.canonical) AS is_chained
      FROM resolved r
  ),
  -- Skip edges whose alias is already in the table, or is the canonical of an existing row. Rejected
  -- rows count here on purpose: a rejected pair is never added again, in either direction.
  keep AS (
    SELECT c.organ, c.alias, c.canonical, c.rule
      FROM classified c
     WHERE NOT c.is_self AND NOT c.is_chained
       AND NOT EXISTS (SELECT 1 FROM public.contract_expedient_aliases t
                        WHERE t.organ = c.organ AND t.alias_codi_expedient = c.alias)
       AND NOT EXISTS (SELECT 1 FROM public.contract_expedient_aliases t
                        WHERE t.organ = c.organ AND t.canonical_codi_expedient = c.alias)
  ),
  ins AS (
    INSERT INTO public.contract_expedient_aliases (organ, alias_codi_expedient, canonical_codi_expedient, reason, rule)
    SELECT k.organ, k.alias, k.canonical,
           CASE k.rule
             WHEN 'auto_code_format' THEN 'Regla auto_code_format: el mateix contracte publicat amb dos formats del codi d''expedient; només compta el canònic.'
             ELSE 'Regla auto_phase: la fase o ronda d''un expedient publicada com a contracte apart (mateix import, lot i data); només compta l''expedient base.'
           END,
           k.rule
      FROM keep k
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins)::integer,
         (SELECT count(*) FROM classified WHERE is_self)::integer,
         (SELECT count(*) FROM classified WHERE NOT is_self AND is_chained)::integer
    INTO aliases_added, v_self, v_chained;

  -- d. Supersede every live row under ANY alias (every rule but 'rejected') that has a live canonical twin. Two
  -- branches, one per partial unique index; the twin is the one the trigger looks for, with the
  -- compatible-lot predicate.
  UPDATE public.contracts c SET superseded = true
    FROM public.contract_expedient_aliases a
   WHERE c.organ = a.organ
     AND c.codi_expedient = a.alias_codi_expedient
     AND c.superseded IS NOT TRUE
     AND c.cif IS NOT NULL AND c.cif <> ''
     AND (p_organ IS NULL OR a.organ = p_organ)
     AND a.rule <> 'rejected'
     AND EXISTS (SELECT 1 FROM public.contracts t
                  WHERE t.codi_expedient = a.canonical_codi_expedient
                    AND t.cif = c.cif AND t.cif <> ''
                    AND (t.lot_number = c.lot_number OR coalesce(c.lot_number, '') = '' OR coalesce(t.lot_number, '') = '')
                    AND t.organ = c.organ
                    AND t.amount = c.amount
                    AND t.superseded IS NOT TRUE);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  rows_superseded := rows_superseded + v_rows;

  UPDATE public.contracts c SET superseded = true
    FROM public.contract_expedient_aliases a
   WHERE c.organ = a.organ
     AND c.codi_expedient = a.alias_codi_expedient
     AND c.superseded IS NOT TRUE
     AND (c.cif IS NULL OR c.cif = '')
     AND (p_organ IS NULL OR a.organ = p_organ)
     AND a.rule <> 'rejected'
     AND EXISTS (SELECT 1 FROM public.contracts t
                  WHERE t.codi_expedient = a.canonical_codi_expedient
                    AND (t.cif IS NULL OR t.cif = '')
                    AND t.entity_slug = c.entity_slug
                    AND (t.lot_number = c.lot_number OR coalesce(c.lot_number, '') = '' OR coalesce(t.lot_number, '') = '')
                    AND t.organ = c.organ
                    AND t.amount = c.amount
                    AND t.superseded IS NOT TRUE);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  rows_superseded := rows_superseded + v_rows;

  RAISE NOTICE 'detect_contract_expedient_aliases(%): % alias(es) added, % row(s) superseded, % self-edge(s) and % chained edge(s) dropped',
    COALESCE(p_organ, 'all organs'), aliases_added, rows_superseded, v_self, v_chained;

  RETURN NEXT;
END;
$function$;

-- Source: production schema
-- 1. Official annulment lines. line_key is the md5 of every field of the line, computed by the script, so a line that is
-- already known is never written twice. amount is NULL when the source sends something that is not a plain
-- number (a list of suppliers separated by pipes).
CREATE TABLE IF NOT EXISTS public.contract_official_annulments (
  line_key        text        PRIMARY KEY,
  url             text        NOT NULL,
  codi_expedient  text        NOT NULL,
  organ           text        NOT NULL,
  adjudicatari_id text,
  adjudicatari    text,
  amount          numeric,
  award_date      date,
  resultat        text        NOT NULL DEFAULT '',
  agregada        text,
  annul_date      date,
  fetched_at      timestamptz NOT NULL DEFAULT now()
);

-- Source: production schema
CREATE INDEX IF NOT EXISTS idx_contract_official_annulments_codi ON public.contract_official_annulments (codi_expedient);

-- Source: production schema
CREATE INDEX IF NOT EXISTS idx_contract_official_annulments_organ ON public.contract_official_annulments (organ);

-- Source: production schema
-- 2. Decisions, one per affected contract, by natural key. cif is empty when the contract has none; then
-- entity_slug carries the identity, otherwise entity_slug is empty.
CREATE TABLE IF NOT EXISTS public.contract_annulment_decisions (
  organ          text        NOT NULL,
  codi_expedient text        NOT NULL,
  cif            text        NOT NULL DEFAULT '',
  entity_slug    text        NOT NULL DEFAULT '',
  lot_number     text        NOT NULL DEFAULT '',
  decision       text        NOT NULL,
  reason         text        NOT NULL,
  evidence       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organ, codi_expedient, cif, entity_slug, lot_number),
  CHECK (decision IN ('supersede', 'unsupersede', 'keep')),
  CHECK (reason IN ('not_awarded', 'annulled_double_count', 'swap_to_valid_copy', 'no_valid_publication', 'kept_republished_absent_locally')),
  CHECK (
    (decision = 'supersede' AND reason IN ('not_awarded', 'annulled_double_count', 'swap_to_valid_copy', 'no_valid_publication'))
    OR (decision = 'unsupersede' AND reason = 'swap_to_valid_copy')
    OR (decision = 'keep' AND reason = 'kept_republished_absent_locally')
  )
);

-- Source: production schema
-- 3. The decision SQL, read-only. One row per contract that needs a decision or an answer:
--   outcome 'decided'                  decision and reason are set;
--   outcome 'official_check'           rule 4 candidate, to be answered by the source check;
--   outcome 'other_copies_superseded'  valid copies exist but were superseded by other sweeps and are not tied
--                                      through an alias: left as they are.
-- Rules 2 to 4 look only at live annulment-derived rows, so a second pass after the decisions were applied
-- finds nothing new; rule 1 looks at the whole award whatever its state.
-- Both branches (with and without cif) carry the predicate of the partial unique index that serves them
-- (uq_contract_v2_cif, uq_contract_v2_slug).
CREATE OR REPLACE FUNCTION public.contract_annulment_classify(p_organ text DEFAULT NULL)
 RETURNS TABLE (
   contract_id     uuid,
   organ           text,
   codi_expedient  text,
   key_cif         text,
   key_slug        text,
   lot_number      text,
   amount          numeric,
   is_live         boolean,
   outcome         text,
   decision        text,
   reason          text,
   evidence        jsonb,
   line_url        text,
   adjudicatari_id text,
   adjudicatari    text,
   award_date      date
 )
 LANGUAGE sql
 STABLE
 SET search_path = public
 SET plan_cache_mode = force_custom_plan
AS $function$
WITH
-- Annulment-derived rows: publication, code and amount equal to an official line.
ann_all AS MATERIALIZED (
  SELECT c.id, c.organ, c.codi_expedient, c.cif, c.entity_slug, c.lot_number, c.amount,
         (c.superseded IS NOT TRUE) AS is_live,
         l.url, l.resultat, l.adjudicatari_id, l.adjudicatari, l.award_date, l.line_key
    FROM public.contract_official_annulments l
    JOIN public.contracts c
      ON c.codi_expedient = l.codi_expedient AND c.publication_url = l.url AND c.amount = l.amount
   WHERE c.codi_expedient IS NOT NULL AND c.cif IS NOT NULL AND c.cif <> ''
     AND c.organ IS NOT NULL AND c.organ <> ''
     AND (p_organ IS NULL OR (l.organ = p_organ AND c.organ = p_organ))
  UNION ALL
  SELECT c.id, c.organ, c.codi_expedient, c.cif, c.entity_slug, c.lot_number, c.amount,
         (c.superseded IS NOT TRUE) AS is_live,
         l.url, l.resultat, l.adjudicatari_id, l.adjudicatari, l.award_date, l.line_key
    FROM public.contract_official_annulments l
    JOIN public.contracts c
      ON c.codi_expedient = l.codi_expedient AND c.publication_url = l.url AND c.amount = l.amount
   WHERE c.codi_expedient IS NOT NULL AND (c.cif IS NULL OR c.cif = '')
     AND c.entity_slug IS NOT NULL
     AND c.organ IS NOT NULL AND c.organ <> ''
     AND (p_organ IS NULL OR (l.organ = p_organ AND c.organ = p_organ))
),
-- One line per row; a line that says the award did not happen wins over one that does not.
ann AS MATERIALIZED (
  SELECT DISTINCT ON (a.id) a.*,
         (a.resultat IN ('Desistiment', 'Renúncia', 'Desert')) AS not_awarded
    FROM ann_all a
   ORDER BY a.id, (a.resultat IN ('Desistiment', 'Renúncia', 'Desert')) DESC, a.line_key
),
-- Rows that need their copies: rule 1 rows, and the live rows rules 2 to 4 look at.
need AS MATERIALIZED (
  SELECT a.* FROM ann a WHERE a.not_awarded OR a.is_live
),
-- Copies of those awards: every row with the same identity, amount and organ, live or not.
--   With p_organ the rows are read per supplier identity through the cif and slug indexes, keeping only the
--   amounts that occur. Without it the contracts are read ONCE and hash-joined to the keys of the rows
--   above: the key expression cannot use an index, so the planner never falls back to one index probe per
--   candidate, which is what makes a full run slow.
g_cif AS MATERIALIZED (
  SELECT n.cif, array_agg(DISTINCT n.amount) AS amounts
    FROM need n
   WHERE p_organ IS NOT NULL AND n.cif IS NOT NULL AND n.cif <> ''
   GROUP BY n.cif
),
g_slug AS MATERIALIZED (
  SELECT n.entity_slug, array_agg(DISTINCT n.amount) AS amounts
    FROM need n
   WHERE p_organ IS NOT NULL AND (n.cif IS NULL OR n.cif = '')
   GROUP BY n.entity_slug
),
keys AS MATERIALIZED (
  SELECT DISTINCT (CASE WHEN COALESCE(n.cif, '') <> '' THEN 'c|' || n.cif ELSE 's|' || n.entity_slug END
                   || '|' || n.amount::text || '|' || n.organ) AS k
    FROM need n
   WHERE p_organ IS NULL
),
rel AS MATERIALIZED (
  SELECT t.id, t.organ, t.codi_expedient, t.cif, t.entity_slug, t.lot_number, t.amount,
         (t.superseded IS NOT TRUE) AS is_live
    FROM g_cif g
    JOIN public.contracts t ON t.cif = g.cif AND t.amount = ANY (g.amounts)
   WHERE t.organ IS NOT NULL AND t.organ <> ''
  UNION ALL
  SELECT t.id, t.organ, t.codi_expedient, t.cif, t.entity_slug, t.lot_number, t.amount,
         (t.superseded IS NOT TRUE) AS is_live
    FROM g_slug g
    JOIN public.contracts t ON t.entity_slug = g.entity_slug AND t.amount = ANY (g.amounts)
   WHERE (t.cif IS NULL OR t.cif = '') AND t.organ IS NOT NULL AND t.organ <> ''
  UNION ALL
  SELECT t.id, t.organ, t.codi_expedient, t.cif, t.entity_slug, t.lot_number, t.amount,
         (t.superseded IS NOT TRUE) AS is_live
    FROM public.contracts t
    JOIN keys k
      ON k.k = (CASE WHEN COALESCE(t.cif, '') <> '' THEN 'c|' || t.cif ELSE 's|' || COALESCE(t.entity_slug, '') END
                || '|' || t.amount::text || '|' || t.organ)
   WHERE p_organ IS NULL AND t.organ IS NOT NULL AND t.organ <> '' AND t.amount IS NOT NULL
),
-- Rule 1: every row of the award under the code of the line.
na AS (
  SELECT r.id, r.organ, r.codi_expedient, r.cif, r.entity_slug, r.lot_number, r.amount, r.is_live,
         a.url, a.resultat, a.adjudicatari_id, a.adjudicatari, a.award_date, a.line_key
    FROM ann a
    JOIN rel r
      ON r.codi_expedient = a.codi_expedient AND r.organ = a.organ AND r.amount = a.amount
     AND COALESCE(r.cif, '') = COALESCE(a.cif, '')
     AND (COALESCE(a.cif, '') <> '' OR r.entity_slug = a.entity_slug)
     AND (r.lot_number = a.lot_number OR a.lot_number = '' OR r.lot_number = '')
   WHERE a.not_awarded
),
-- Rules 2 to 4 start from the live annulment-derived rows that are not rule 1.
cand AS MATERIALIZED (
  SELECT a.* FROM ann a WHERE NOT a.not_awarded AND a.is_live
),
-- Valid copies of each candidate's award under any code, live or not.
cop AS MATERIALIZED (
  SELECT a.id AS a_id, t.id AS t_id, t.codi_expedient AS t_codi, t.lot_number AS t_lot, t.is_live AS t_live
    FROM cand a
    JOIN rel t
      ON t.amount = a.amount AND t.organ = a.organ AND t.id <> a.id
     AND COALESCE(t.cif, '') = COALESCE(a.cif, '')
     AND (COALESCE(a.cif, '') <> '' OR t.entity_slug = a.entity_slug)
     AND (t.lot_number = a.lot_number OR a.lot_number = '' OR t.lot_number = '')
   WHERE NOT EXISTS (SELECT 1 FROM ann x WHERE x.id = t.id)
),
-- Rule 2: a live valid copy exists.
r2 AS (
  SELECT c.a_id, min(c.t_codi) AS copy_codi
    FROM cop c
   WHERE c.t_live
   GROUP BY c.a_id
),
-- Rule 3: no live valid copy, and a superseded one sits under an alias of this row's code.
r3 AS (
  SELECT DISTINCT ON (c.a_id) c.a_id, c.t_id, c.t_codi
    FROM cop c
    JOIN cand a ON a.id = c.a_id
    JOIN public.contract_expedient_aliases al
      ON al.organ = a.organ AND al.canonical_codi_expedient = a.codi_expedient
     AND al.alias_codi_expedient = c.t_codi AND al.rule <> 'rejected'
   WHERE NOT c.t_live
     AND NOT EXISTS (SELECT 1 FROM r2 WHERE r2.a_id = c.a_id)
   ORDER BY c.a_id, (c.t_lot = a.lot_number) DESC, (c.t_lot <> '') DESC, c.t_id
),
-- Rule 2 again, once the swaps are counted: a copy that rule 3 sets live is a live valid copy for the other
-- annulment-derived rows of the same award, which would otherwise be a double count on the next run.
r2b AS (
  SELECT c.a_id, min(c.t_codi) AS copy_codi
    FROM cop c
   WHERE NOT c.t_live
     AND c.t_id IN (SELECT r3.t_id FROM r3)
     AND NOT EXISTS (SELECT 1 FROM r2 WHERE r2.a_id = c.a_id)
     AND NOT EXISTS (SELECT 1 FROM r3 WHERE r3.a_id = c.a_id)
   GROUP BY c.a_id
),
decided AS (
  -- Rule 1.
  SELECT n.id AS contract_id, n.organ, n.codi_expedient, n.cif, n.entity_slug, n.lot_number, n.amount, n.is_live,
         'decided'::text AS outcome, 'supersede'::text AS decision, 'not_awarded'::text AS reason,
         jsonb_build_object('annulment_url', n.url, 'resultat', n.resultat) AS evidence,
         1 AS prio, n.line_key, n.url AS line_url, n.adjudicatari_id, n.adjudicatari, n.award_date
    FROM na n
  UNION ALL
  -- Rule 2.
  SELECT a.id, a.organ, a.codi_expedient, a.cif, a.entity_slug, a.lot_number, a.amount, a.is_live,
         'decided', 'supersede', 'annulled_double_count',
         jsonb_build_object('annulment_url', a.url, 'resultat', a.resultat, 'valid_copy_codi_expedient', r2.copy_codi),
         2, a.line_key, a.url, a.adjudicatari_id, a.adjudicatari, a.award_date
    FROM cand a
    JOIN r2 ON r2.a_id = a.id
  UNION ALL
  -- Rule 2, copy set live by a swap.
  SELECT a.id, a.organ, a.codi_expedient, a.cif, a.entity_slug, a.lot_number, a.amount, a.is_live,
         'decided', 'supersede', 'annulled_double_count',
         jsonb_build_object('annulment_url', a.url, 'resultat', a.resultat, 'valid_copy_codi_expedient', r2b.copy_codi),
         2, a.line_key, a.url, a.adjudicatari_id, a.adjudicatari, a.award_date
    FROM cand a
    JOIN r2b ON r2b.a_id = a.id
  UNION ALL
  -- Rule 3: the annulment-derived row is superseded.
  SELECT a.id, a.organ, a.codi_expedient, a.cif, a.entity_slug, a.lot_number, a.amount, a.is_live,
         'decided', 'supersede', 'swap_to_valid_copy',
         jsonb_build_object('annulment_url', a.url, 'resultat', a.resultat, 'valid_copy_codi_expedient', r3.t_codi),
         3, a.line_key, a.url, a.adjudicatari_id, a.adjudicatari, a.award_date
    FROM cand a
    JOIN r3 ON r3.a_id = a.id
  UNION ALL
  -- Rule 3: the alias copy is set live.
  SELECT b.id, b.organ, b.codi_expedient, b.cif, b.entity_slug, b.lot_number, b.amount, (b.superseded IS NOT TRUE),
         'decided', 'unsupersede', 'swap_to_valid_copy',
         jsonb_build_object('annulment_url', a.url, 'resultat', a.resultat, 'annulled_codi_expedient', a.codi_expedient),
         4, a.line_key, a.url, a.adjudicatari_id, a.adjudicatari, a.award_date
    FROM r3
    JOIN cand a ON a.id = r3.a_id
    JOIN public.contracts b ON b.id = r3.t_id
  UNION ALL
  -- Rule 4: no valid copy at all, so the source decides.
  SELECT a.id, a.organ, a.codi_expedient, a.cif, a.entity_slug, a.lot_number, a.amount, a.is_live,
         'official_check', NULL::text, NULL::text, '{}'::jsonb,
         5, a.line_key, a.url, a.adjudicatari_id, a.adjudicatari, a.award_date
    FROM cand a
   WHERE NOT EXISTS (SELECT 1 FROM r2 WHERE r2.a_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM r2b WHERE r2b.a_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM r3 WHERE r3.a_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM cop WHERE cop.a_id = a.id)
  UNION ALL
  -- Valid copies exist but were superseded by other sweeps: left as they are.
  SELECT a.id, a.organ, a.codi_expedient, a.cif, a.entity_slug, a.lot_number, a.amount, a.is_live,
         'other_copies_superseded', NULL::text, NULL::text, '{}'::jsonb,
         6, a.line_key, a.url, a.adjudicatari_id, a.adjudicatari, a.award_date
    FROM cand a
   WHERE NOT EXISTS (SELECT 1 FROM r2 WHERE r2.a_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM r2b WHERE r2b.a_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM r3 WHERE r3.a_id = a.id)
     AND EXISTS (SELECT 1 FROM cop WHERE cop.a_id = a.id)
)
SELECT DISTINCT ON (d.contract_id)
       d.contract_id, d.organ, d.codi_expedient,
       COALESCE(d.cif, '') AS key_cif,
       CASE WHEN COALESCE(d.cif, '') = '' THEN COALESCE(d.entity_slug, '') ELSE '' END AS key_slug,
       d.lot_number, d.amount, d.is_live, d.outcome, d.decision, d.reason, d.evidence,
       d.line_url, d.adjudicatari_id, d.adjudicatari, d.award_date
  FROM decided d
 ORDER BY d.contract_id, d.prio, d.line_key
$function$;

-- Source: production schema
-- 4. Store the decisions of rules 1 to 3. Only rows that change are written, so a second run changes
-- nothing. Returns one row per (decision, reason): rows decided, their amount, how many were written, and
-- how many of those rows are live now (with their amount). Decision 'none' reports the rows left pending
-- (reason pending_official_check, with the candidates of rule 4 as jsonb in detail) or untouched
-- (other_copies_superseded). The classification is the only heavy read: call it once per run.
CREATE OR REPLACE FUNCTION public.decide_contract_annulments(p_organ text DEFAULT NULL)
 RETURNS TABLE (
   decision_kind   text,
   decision_reason text,
   n_rows          integer,
   total_amount    numeric,
   n_changed       integer,
   n_live          integer,
   live_amount     numeric,
   detail          jsonb
 )
 LANGUAGE plpgsql
 SET search_path = public
 SET plan_cache_mode = force_custom_plan
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('contract_dedup'));

  RETURN QUERY
  WITH resolved AS (
    SELECT k.organ, k.codi_expedient, k.key_cif, k.key_slug, k.lot_number, k.amount, k.is_live,
           CASE WHEN k.outcome = 'decided' THEN k.decision ELSE 'none' END AS dec,
           CASE WHEN k.outcome = 'decided' THEN k.reason
                WHEN k.outcome = 'official_check' THEN 'pending_official_check'
                ELSE k.outcome END AS why,
           k.evidence AS evid,
           k.line_url, k.adjudicatari_id, k.adjudicatari, k.award_date
      FROM public.contract_annulment_classify(p_organ) k
  ),
  up AS (
    INSERT INTO public.contract_annulment_decisions AS d
      (organ, codi_expedient, cif, entity_slug, lot_number, decision, reason, evidence)
    SELECT r.organ, r.codi_expedient, r.key_cif, r.key_slug, r.lot_number, r.dec, r.why, r.evid
      FROM resolved r
     WHERE r.dec <> 'none'
    ON CONFLICT (organ, codi_expedient, cif, entity_slug, lot_number) DO UPDATE
      SET decision = EXCLUDED.decision, reason = EXCLUDED.reason, evidence = EXCLUDED.evidence, decided_at = now()
      WHERE (d.decision, d.reason, d.evidence) IS DISTINCT FROM (EXCLUDED.decision, EXCLUDED.reason, EXCLUDED.evidence)
    RETURNING d.organ, d.codi_expedient, d.cif, d.entity_slug, d.lot_number
  )
  SELECT r.dec, r.why, count(*)::integer, COALESCE(sum(r.amount), 0), count(u.organ)::integer,
         (count(*) FILTER (WHERE r.is_live))::integer, COALESCE(sum(r.amount) FILTER (WHERE r.is_live), 0),
         CASE WHEN r.why = 'pending_official_check' THEN
           jsonb_agg(jsonb_build_object(
             'organ', r.organ, 'codiExpedient', r.codi_expedient, 'keyCif', r.key_cif, 'keySlug', r.key_slug,
             'lotNumber', r.lot_number, 'lineUrl', r.line_url, 'adjudicatariId', r.adjudicatari_id,
             'adjudicatari', r.adjudicatari, 'amount', r.amount, 'awardDate', r.award_date))
         END
    FROM resolved r
    LEFT JOIN up u
      ON u.organ = r.organ AND u.codi_expedient = r.codi_expedient AND u.cif = r.key_cif
     AND u.entity_slug = r.key_slug AND u.lot_number = r.lot_number
   GROUP BY r.dec, r.why;
END;
$function$;

-- Source: production schema
-- Rule 4 from the answers of the source check. Each answer names a contract by natural key and the annulment
-- url it was derived from; it counts only while that contract is still live and still on that publication,
-- and its annulment line still exists. found = true: the source has a valid record that this database lacks
-- (keep); found = false: it has none (supersede). Answers that no longer fit a live contract are reported
-- as 'none' / answer_without_live_row and change nothing. Reads only the contracts the answers name.
CREATE OR REPLACE FUNCTION public.decide_contract_annulment_checks(p_official jsonb)
 RETURNS TABLE (decision_kind text, decision_reason text, n_rows integer, n_changed integer)
 LANGUAGE plpgsql
 SET search_path = public
 SET plan_cache_mode = force_custom_plan
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('contract_dedup'));

  RETURN QUERY
  WITH chk AS (
    SELECT e.value ->> 'organ' AS organ,
           e.value ->> 'codi_expedient' AS codi_expedient,
           COALESCE(e.value ->> 'cif', '') AS cif,
           COALESCE(e.value ->> 'entity_slug', '') AS entity_slug,
           COALESCE(e.value ->> 'lot_number', '') AS lot_number,
           e.value ->> 'line_url' AS line_url,
           bool_or(COALESCE((e.value ->> 'found')::boolean, false)) AS found,
           max(e.value ->> 'record_id') AS record_id
      FROM jsonb_array_elements(COALESCE(p_official, '[]'::jsonb)) AS e(value)
     GROUP BY 1, 2, 3, 4, 5, 6
  ),
  hit AS (
    SELECT c.organ, c.codi_expedient, c.cif, c.entity_slug, c.lot_number, c.line_url, c.found, c.record_id
      FROM chk c
      JOIN public.contracts t
        ON t.codi_expedient = c.codi_expedient AND t.cif = c.cif AND t.lot_number = c.lot_number AND t.organ = c.organ
     WHERE c.cif <> '' AND t.cif <> '' AND t.superseded IS NOT TRUE AND t.publication_url = c.line_url
       AND EXISTS (SELECT 1 FROM public.contract_official_annulments l
                    WHERE l.codi_expedient = c.codi_expedient AND l.url = c.line_url AND l.amount = t.amount)
    UNION ALL
    SELECT c.organ, c.codi_expedient, c.cif, c.entity_slug, c.lot_number, c.line_url, c.found, c.record_id
      FROM chk c
      JOIN public.contracts t
        ON t.codi_expedient = c.codi_expedient AND t.entity_slug = c.entity_slug AND t.lot_number = c.lot_number AND t.organ = c.organ
     WHERE c.cif = '' AND (t.cif IS NULL OR t.cif = '') AND t.superseded IS NOT TRUE AND t.publication_url = c.line_url
       AND EXISTS (SELECT 1 FROM public.contract_official_annulments l
                    WHERE l.codi_expedient = c.codi_expedient AND l.url = c.line_url AND l.amount = t.amount)
  ),
  resolved AS (
    SELECT h.organ, h.codi_expedient, h.cif, h.entity_slug, h.lot_number,
           CASE WHEN h.found THEN 'keep' ELSE 'supersede' END AS dec,
           CASE WHEN h.found THEN 'kept_republished_absent_locally' ELSE 'no_valid_publication' END AS why,
           CASE WHEN h.found THEN jsonb_build_object('annulment_url', h.line_url, 'official_record_id', h.record_id)
                ELSE jsonb_build_object('annulment_url', h.line_url, 'official_check', 'no_valid_record') END AS evid
      FROM hit h
  ),
  up AS (
    INSERT INTO public.contract_annulment_decisions AS d
      (organ, codi_expedient, cif, entity_slug, lot_number, decision, reason, evidence)
    SELECT r.organ, r.codi_expedient, r.cif, r.entity_slug, r.lot_number, r.dec, r.why, r.evid
      FROM resolved r
    ON CONFLICT (organ, codi_expedient, cif, entity_slug, lot_number) DO UPDATE
      SET decision = EXCLUDED.decision, reason = EXCLUDED.reason, evidence = EXCLUDED.evidence, decided_at = now()
      WHERE (d.decision, d.reason, d.evidence) IS DISTINCT FROM (EXCLUDED.decision, EXCLUDED.reason, EXCLUDED.evidence)
    RETURNING d.decision, d.reason
  )
  SELECT r.dec, r.why, count(*)::integer,
         (SELECT count(*) FROM up WHERE up.decision = r.dec AND up.reason = r.why)::integer
    FROM resolved r
   GROUP BY r.dec, r.why
  UNION ALL
  SELECT 'none'::text, 'answer_without_live_row'::text,
         ((SELECT count(*) FROM chk) - (SELECT count(*) FROM hit))::integer, 0
   WHERE (SELECT count(*) FROM chk) > (SELECT count(*) FROM hit);
END;
$function$;

-- Source: production schema
-- 5. Re-apply the stored decisions. First every 'supersede' on live rows, then every 'unsupersede' on
-- superseded rows: the alias trigger keeps an alias row superseded while a live canonical twin exists, so
-- the canonical row has to be superseded first. Four UPDATEs, one per decision and identity branch, each
-- reaching contracts through the unique index that serves it. An 'unsupersede' that the alias trigger puts
-- back is not counted. Returns the entities of the rows that changed, for the targeted recompute.
CREATE OR REPLACE FUNCTION public.apply_contract_annulments(p_organ text DEFAULT NULL)
 RETURNS TABLE (rows_superseded integer, rows_unsuperseded integer, entity_ids uuid[])
 LANGUAGE plpgsql
 SET search_path = public
 SET plan_cache_mode = force_custom_plan
AS $function$
DECLARE
  v_n1 integer;
  v_n2 integer;
  v_n3 integer;
  v_n4 integer;
  v_e1 uuid[];
  v_e2 uuid[];
  v_e3 uuid[];
  v_e4 uuid[];
BEGIN
  rows_superseded := 0;
  rows_unsuperseded := 0;

  PERFORM pg_advisory_xact_lock(hashtext('contract_dedup'));

  -- 1. Supersede, with cif.
  WITH u AS (
    UPDATE public.contracts c SET superseded = true
      FROM public.contract_annulment_decisions d
     WHERE d.decision = 'supersede' AND d.cif <> ''
       AND (p_organ IS NULL OR d.organ = p_organ)
       AND c.codi_expedient = d.codi_expedient AND c.cif = d.cif AND c.cif <> '' AND c.lot_number = d.lot_number
       AND c.organ = d.organ AND c.superseded IS NOT TRUE
    RETURNING c.entity_id
  )
  SELECT count(*)::integer, COALESCE(array_agg(DISTINCT u.entity_id) FILTER (WHERE u.entity_id IS NOT NULL), ARRAY[]::uuid[])
    INTO v_n1, v_e1 FROM u;

  -- 2. Supersede, without cif.
  WITH u AS (
    UPDATE public.contracts c SET superseded = true
      FROM public.contract_annulment_decisions d
     WHERE d.decision = 'supersede' AND d.cif = ''
       AND (p_organ IS NULL OR d.organ = p_organ)
       AND c.codi_expedient = d.codi_expedient AND (c.cif IS NULL OR c.cif = '')
       AND c.entity_slug = d.entity_slug AND c.lot_number = d.lot_number
       AND c.organ = d.organ AND c.superseded IS NOT TRUE
    RETURNING c.entity_id
  )
  SELECT count(*)::integer, COALESCE(array_agg(DISTINCT u.entity_id) FILTER (WHERE u.entity_id IS NOT NULL), ARRAY[]::uuid[])
    INTO v_n2, v_e2 FROM u;

  -- 3. Unsupersede, with cif.
  WITH u AS (
    UPDATE public.contracts c SET superseded = false
      FROM public.contract_annulment_decisions d
     WHERE d.decision = 'unsupersede' AND d.cif <> ''
       AND (p_organ IS NULL OR d.organ = p_organ)
       AND c.codi_expedient = d.codi_expedient AND c.cif = d.cif AND c.cif <> '' AND c.lot_number = d.lot_number
       AND c.organ = d.organ AND c.superseded = true
    RETURNING c.entity_id, c.superseded
  )
  SELECT count(*) FILTER (WHERE u.superseded IS NOT TRUE)::integer,
         COALESCE(array_agg(DISTINCT u.entity_id) FILTER (WHERE u.entity_id IS NOT NULL AND u.superseded IS NOT TRUE), ARRAY[]::uuid[])
    INTO v_n3, v_e3 FROM u;

  -- 4. Unsupersede, without cif.
  WITH u AS (
    UPDATE public.contracts c SET superseded = false
      FROM public.contract_annulment_decisions d
     WHERE d.decision = 'unsupersede' AND d.cif = ''
       AND (p_organ IS NULL OR d.organ = p_organ)
       AND c.codi_expedient = d.codi_expedient AND (c.cif IS NULL OR c.cif = '')
       AND c.entity_slug = d.entity_slug AND c.lot_number = d.lot_number
       AND c.organ = d.organ AND c.superseded = true
    RETURNING c.entity_id, c.superseded
  )
  SELECT count(*) FILTER (WHERE u.superseded IS NOT TRUE)::integer,
         COALESCE(array_agg(DISTINCT u.entity_id) FILTER (WHERE u.entity_id IS NOT NULL AND u.superseded IS NOT TRUE), ARRAY[]::uuid[])
    INTO v_n4, v_e4 FROM u;

  rows_superseded := v_n1 + v_n2;
  rows_unsuperseded := v_n3 + v_n4;
  entity_ids := ARRAY(SELECT DISTINCT x FROM unnest(v_e1 || v_e2 || v_e3 || v_e4) AS x);

  RAISE NOTICE 'apply_contract_annulments(%): % row(s) superseded, % row(s) set live, % entity(ies) touched',
    COALESCE(p_organ, 'all organs'), rows_superseded, rows_unsuperseded, COALESCE(array_length(entity_ids, 1), 0);

  RETURN NEXT;
END;
$function$;
