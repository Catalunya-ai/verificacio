-- =====================================================================
-- Tables used by the connectors, the aggregation and the score.
--
-- Consolidated from the production schema: each table carries the
-- columns that the code in this repository reads or writes, with the type
-- and default of the production schema, and the unique indexes
-- that its ON CONFLICT clauses rely on. Columns of the product (search,
-- networks of people, enrichment shown only on the site) are left out.
--
-- Four columns of `entities` are not in the production schema but are
-- read or written by the code: score_frequency, first_contract_year and
-- last_contract_year (the score) and cif_aliases (the stub reconciliation).
-- They are declared here with the type the code expects. No step of the
-- pipeline fills first_contract_year, last_contract_year or cif_aliases
-- (see DICCIONARI.md).
--
-- Every table is created IF NOT EXISTS: the file can be run again.
-- =====================================================================

-- ── Territorial lookup (seed-territorial-mapping.ts) ──────────────────
-- Source: production schema
CREATE TABLE IF NOT EXISTS territorial_mapping (
  codi_territorial TEXT PRIMARY KEY,
  comarca_code     TEXT NOT NULL,
  province_code    TEXT NOT NULL,
  comarca_name     TEXT NOT NULL,
  province_name    TEXT NOT NULL
);

-- ── Beneficiaries ─────────────────────────────────────────────────────
-- Source: production schema.
CREATE TABLE IF NOT EXISTS entities (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                        TEXT CONSTRAINT entities_slug_key UNIQUE,
  cif                         TEXT,
  name                        TEXT NOT NULL,
  name_source                 TEXT,
  beneficiary_type            TEXT,
  municipality                TEXT,
  comarca                     TEXT,
  comarca_code                TEXT,
  province_code               TEXT,
  is_anonymized               BOOLEAN DEFAULT FALSE,
  is_person                   BOOLEAN DEFAULT FALSE,
  is_public_entity            BOOLEAN DEFAULT FALSE,

  -- Entity resolution: names and slugs folded into this entity by the merges
  -- (merge_entity_stub, sql/pipeline/020 and 030), and the normalised name the
  -- stub reconciliation compares.
  name_norm                   TEXT GENERATED ALWAYS AS (
                                regexp_replace(upper(public.immutable_unaccent(name)), '[^A-Z0-9 ]+', ' ', 'g')
                              ) STORED,
  slug_aliases                TEXT[] DEFAULT '{}',
  also_known_as               TEXT[] DEFAULT '{}',
  aka_norm                    TEXT,
  alt_cifs                    TEXT[] DEFAULT '{}',
  cif_aliases                 TEXT[],  -- not in the production schema; no step fills it

  -- Grants (RAISC), ICF credits kept apart
  total_amount                DECIMAL(15,2) DEFAULT 0,
  total_grants                INTEGER DEFAULT 0,
  first_grant_year            INTEGER,
  last_grant_year             INTEGER,
  total_credit_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_credits               INTEGER NOT NULL DEFAULT 0,

  -- Public contracts
  total_contracts             INTEGER DEFAULT 0,
  total_contract_amount       DECIMAL(15,2) DEFAULT 0,
  first_contract_year         INTEGER,  -- not in the production schema; no step fills it
  last_contract_year          INTEGER,  -- not in the production schema; no step fills it
  primary_organ               TEXT,
  primary_contract_type       TEXT,

  -- Other channels
  total_convenis              INTEGER DEFAULT 0,
  total_conveni_amount        DECIMAL(15,2) DEFAULT 0,
  total_budget_transfers      DECIMAL(15,2) DEFAULT 0,
  total_equity_contributions  DECIMAL(15,2) DEFAULT 0,
  total_accio_concertada      NUMERIC(15,2) DEFAULT 0,
  total_public_funds          DECIMAL(15,2) DEFAULT 0,

  -- Contract network (analyze-contract-network.ts)
  sole_source_count           INTEGER DEFAULT 0,
  sole_source_amount          DECIMAL(15,2) DEFAULT 0,
  sole_source_pct             DECIMAL(5,2) DEFAULT 0,
  fragmentation_risk          DECIMAL(5,2) DEFAULT 0,
  fragmentation_count         INTEGER DEFAULT 0,

  -- Accounting transparency (enrich-accountability.ts)
  files_accounts              BOOLEAN,
  latest_account_year         SMALLINT,
  in_official_registry        BOOLEAN,
  grant_dependency_pct        NUMERIC(5,2),
  registry_id_entitat         TEXT,
  account_years               SMALLINT[],
  accountability_ratio        DECIMAL(5,2),
  accountability_source       TEXT,
  accountability_updated_at   TIMESTAMPTZ,
  personnel_cost_pct          NUMERIC(5,2),
  personnel_cost_source       TEXT,
  personnel_cost_year         SMALLINT,
  avg_grant_dependency_pct    NUMERIC(5,2),
  avg_personnel_cost_pct      NUMERIC(5,2),
  financial_years_count       SMALLINT DEFAULT 0,

  -- Menjòmetre score (calculate-scores-sql.ts)
  menjometre_score            DECIMAL(5,2) DEFAULT 0,
  score_volume                DECIMAL(5,2) DEFAULT 0,
  score_frequency             NUMERIC(5,2),  -- not in the production schema; written by the score
  score_dominance             DECIMAL(5,2) DEFAULT 0,
  score_concurrencia          NUMERIC(5,2),
  idx_market_competition      NUMERIC(5,2),
  score_accountability        DECIMAL(5,2),

  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- Source: final form in the production database (a full unique index; the
-- loaders use ON CONFLICT (cif)). NULLs never conflict.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_cif_unique ON entities (cif);
CREATE INDEX IF NOT EXISTS idx_entities_score ON entities (menjometre_score DESC);

-- ── Grants (sync-raisc.ts) ────────────────────────────────────────────
-- Source: production schema
CREATE TABLE IF NOT EXISTS grants (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             UUID REFERENCES entities(id) ON DELETE CASCADE,
  entity_slug           TEXT,
  cif                   TEXT,
  amount                DECIMAL(15,2) NOT NULL,
  department            TEXT NOT NULL,
  sub_purpose           TEXT,
  purpose               TEXT,
  grant_year            INTEGER,
  grant_date            DATE,
  bdns_code             TEXT,
  convocatoria          TEXT,
  source_dataset        TEXT DEFAULT 'mrr_concessions',
  ccaa_code             TEXT,
  raisc_clau            TEXT,
  raisc_code            TEXT,
  beneficiary_type_code TEXT,
  instrument_type       TEXT,
  finalitat_rais        TEXT,
  finalitat_publica     TEXT,
  administracio         TEXT,
  regulatory_url_ca     TEXT,
  regulatory_url_es     TEXT,
  grant_description     TEXT,
  budget_code           TEXT,
  is_state_aid          BOOLEAN DEFAULT FALSE,
  state_aid_mechanism   TEXT,
  eu_reference          TEXT,
  is_credit             BOOLEAN NOT NULL DEFAULT FALSE,
  superseded            BOOLEAN DEFAULT FALSE,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- RAISC record key: a re-run never inserts the same concession twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_raisc_clau ON grants (raisc_clau);
-- Source: production schema (rows without a RAISC key only).
CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_dedup
  ON grants (entity_slug, bdns_code, amount, department)
  WHERE bdns_code IS NOT NULL
    AND raisc_clau IS NULL
    AND entity_slug != 'PERSONAS-FISICAS';
CREATE INDEX IF NOT EXISTS idx_grants_entity ON grants (entity_id);
CREATE INDEX IF NOT EXISTS idx_grants_year ON grants (grant_year);
CREATE INDEX IF NOT EXISTS idx_grants_department ON grants (department);
CREATE INDEX IF NOT EXISTS idx_grants_cif ON grants (cif);
CREATE INDEX IF NOT EXISTS idx_grants_entity_slug_year ON grants (entity_slug, grant_year);
CREATE INDEX IF NOT EXISTS idx_grants_finalitat_rais ON grants (finalitat_rais);

-- ── Per-entity yearly series (aggregate-stats.ts) ─────────────────────
-- Source: production schema
CREATE TABLE IF NOT EXISTS entity_yearly_stats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID REFERENCES entities(id) ON DELETE CASCADE,
  year            INTEGER NOT NULL,
  total_amount    DECIMAL(15,2) DEFAULT 0,
  grant_count     INTEGER DEFAULT 0,
  credit_count    INTEGER NOT NULL DEFAULT 0,
  credit_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  contract_count  INTEGER DEFAULT 0,
  contract_amount DECIMAL(15,2) DEFAULT 0,
  departments     TEXT[] DEFAULT '{}',
  purposes        TEXT[] DEFAULT '{}',
  UNIQUE (entity_id, year)
);

-- ── Public contracts (sync-contractes.ts) ─────────────────────────────
-- Source: production schema
CREATE TABLE IF NOT EXISTS contracts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID REFERENCES entities(id),
  entity_slug     TEXT,
  cif             TEXT,
  codi_expedient  TEXT,
  lot_number      TEXT NOT NULL DEFAULT '',
  source_dataset  TEXT DEFAULT 'contractes_cat',
  amount          DECIMAL(15,2),          -- import d'adjudicació sense IVA
  amount_with_vat DECIMAL(15,2),          -- import d'adjudicació amb IVA
  contract_year   INTEGER,
  contract_date   DATE,
  organ           TEXT,
  contract_type   TEXT,
  procedure_type  TEXT,
  cpv_code        TEXT,
  description     TEXT,
  num_bidders     INTEGER,
  publication_url TEXT,
  superseded      BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Dedup keys of the loader's two ON CONFLICT paths (with and without CIF).
-- The comments of the SQL functions refer to them as uq_contract_v2_cif / _slug.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_v2_cif
  ON contracts (codi_expedient, cif, lot_number)
  WHERE codi_expedient IS NOT NULL AND cif IS NOT NULL AND cif != '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_v2_slug
  ON contracts (codi_expedient, entity_slug, lot_number)
  WHERE codi_expedient IS NOT NULL AND (cif IS NULL OR cif = '');
-- Compact key for rows without CIF (historical slug variants of one supplier).
CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_v2_compact
  ON contracts (
    (coalesce(source_dataset, '')),
    codi_expedient,
    lot_number,
    (coalesce(organ, '')),
    (coalesce(amount, 'NaN'::numeric)),
    (regexp_replace(entity_slug, '[^A-Z0-9]', '', 'g'))
  )
  WHERE codi_expedient IS NOT NULL
    AND (cif IS NULL OR cif = '')
    AND superseded IS NOT TRUE;
CREATE INDEX IF NOT EXISTS idx_contracts_entity ON contracts (entity_id);
CREATE INDEX IF NOT EXISTS idx_contracts_slug ON contracts (entity_slug);
CREATE INDEX IF NOT EXISTS idx_contracts_year ON contracts (contract_year);
CREATE INDEX IF NOT EXISTS idx_contracts_cif ON contracts (cif);

-- ── Cooperation agreements (sync-convenis.ts) ─────────────────────────
-- Source: production schema
CREATE TABLE IF NOT EXISTS convenis (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                UUID REFERENCES entities(id),
  entity_slug              TEXT,
  conveni_number           TEXT,
  title                    TEXT,
  purpose                  TEXT,
  category                 TEXT,
  section_code             TEXT,
  section                  TEXT,
  signatory_department     TEXT,
  signatory_local_entities TEXT,
  signatory_others         TEXT,
  aoc_codes                TEXT,
  amount_generalitat       DECIMAL(15,2),
  amount_local             DECIMAL(15,2),
  amount_other             DECIMAL(15,2),
  amount_total             DECIMAL(15,2),
  signature_date           DATE,
  signature_year           INTEGER,
  expiry_date              DATE,
  is_active                BOOLEAN,
  is_renewable             BOOLEAN,
  document_url             TEXT,
  source_dataset           TEXT DEFAULT 'convenis_cat',
  created_at               TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_convenis_number_slug
  ON convenis (conveni_number, entity_slug)
  WHERE conveni_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_convenis_entity_id ON convenis (entity_id);
CREATE INDEX IF NOT EXISTS idx_convenis_entity_slug ON convenis (entity_slug);

-- ── Generalitat budget transfers (sync-pressupostos.ts) ───────────────
-- Source: production schema
CREATE TABLE IF NOT EXISTS budget_transfers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID REFERENCES entities(id) ON DELETE CASCADE,
  entity_slug     TEXT,
  budget_name_raw TEXT NOT NULL,
  fiscal_year     INTEGER NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  budget_chapter  TEXT NOT NULL,
  department      TEXT NOT NULL,
  budget_line     TEXT NOT NULL,
  initial_budget  DECIMAL(15,2) DEFAULT 0,
  approved_budget DECIMAL(15,2) DEFAULT 0,
  executed_amount DECIMAL(15,2) DEFAULT 0,
  cap_tol_codi    SMALLINT,
  article_codi    SMALLINT,
  source_dataset  TEXT DEFAULT 'pressupostos_generalitat',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bt_matched
  ON budget_transfers (entity_slug, fiscal_year, budget_line, department)
  WHERE entity_slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bt_unmatched
  ON budget_transfers (budget_name_raw, fiscal_year, budget_line, department)
  WHERE entity_slug IS NULL;

-- ── Acció concertada (seed-accio-concertada-sindicatura.ts) ───────────
-- Source: production schema
CREATE TABLE IF NOT EXISTS accio_concertada (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          UUID REFERENCES entities(id),
  entity_slug        TEXT NOT NULL,
  entity_name_source TEXT NOT NULL,   -- name as it appears in the source document
  amount             NUMERIC(15,2) NOT NULL,  -- euros (the report gives thousands)
  year               INTEGER NOT NULL,
  service_type       TEXT,
  department         TEXT,
  legal_instrument   TEXT,
  source_document    TEXT NOT NULL,   -- e.g. 'sindicatura_informe_3_2024'
  source_table       TEXT,            -- e.g. 'quadre_13'
  source_url         TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (entity_slug, year, source_document, source_table)
);

-- ── Filed accounts per year (enrich-accountability.ts) ────────────────
-- Source: production schema
CREATE TABLE IF NOT EXISTS entity_financials_yearly (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  year                 SMALLINT NOT NULL,
  revenue              NUMERIC(15,2),
  grant_income         NUMERIC(15,2),
  personnel_cost       NUMERIC(15,2),
  grant_dependency_pct NUMERIC(5,2),
  personnel_cost_pct   NUMERIC(5,2),
  source               TEXT DEFAULT 'soda_comptes_anuals',
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (entity_id, year)
);

-- ── Contract network signals (analyze-contract-network.ts) ────────────
-- Source: production schema
CREATE TABLE IF NOT EXISTS entity_connections (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_id         UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  related_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  connection_type   TEXT NOT NULL,
  detail            TEXT NOT NULL,
  strength          SMALLINT DEFAULT 1,
  created_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE (entity_id, related_entity_id, connection_type, detail)
);

-- ── Entity consolidation (consolidate-entities.ts) ────────────────────
-- Source: production schema (slug_redirects); entity_merge_log is
-- created by the script itself and declared here for completeness.
CREATE TABLE IF NOT EXISTS slug_redirects (
  old_slug TEXT PRIMARY KEY,
  cif      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_merge_log (
  id             SERIAL PRIMARY KEY,
  old_entity_id  UUID NOT NULL,
  old_slug       TEXT NOT NULL,
  canonical_id   UUID NOT NULL,
  canonical_slug TEXT NOT NULL,
  cif            TEXT,
  merge_type     TEXT,
  merged_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Load log (sync-raisc.ts, sync-contractes.ts) ──────────────────────
-- Source: production schema
CREATE TABLE IF NOT EXISTS data_sync_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_source       TEXT DEFAULT 'mrr_concessions',
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  records_fetched   INTEGER DEFAULT 0,
  records_processed INTEGER DEFAULT 0,
  records_skipped   INTEGER DEFAULT 0,
  last_offset       INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  error_message     TEXT,
  notes             TEXT
);
