-- =====================================================================
-- Natural persons among the beneficiaries (entities.is_person).
--
-- The headline count of entities excludes natural persons. The rule below
-- is the one the production database applied, in the same order:
--
--   1. RAISC beneficiary type PFA (persona física) without a company CIF;
--   2. the beneficiary type copied from the grants when the entity has none,
--      and step 1 again;
--   3. back to false when the name carries an organisation marker;
--   4. beneficiary type FSA (família / persona física agrupada).
--
-- Run it after the loads and the consolidation, before aggregate-stats.ts.
-- Production applied it once, in March 2026; this file applies it to every
-- row, so entities added later are classified too (see DICCIONARI.md).
-- =====================================================================

UPDATE entities SET is_person = true
WHERE beneficiary_type = 'PFA'
  AND (cif IS NULL OR LEFT(cif, 1) SIMILAR TO '[0-9XYZK]');

UPDATE entities e SET beneficiary_type = sub.bt
FROM (
  SELECT DISTINCT ON (g.entity_slug) g.entity_slug, g.beneficiary_type_code as bt
  FROM grants g WHERE g.beneficiary_type_code IS NOT NULL AND g.superseded IS NOT TRUE
  ORDER BY g.entity_slug, g.created_at DESC
) sub
WHERE e.slug = sub.entity_slug AND e.beneficiary_type IS NULL;

UPDATE entities SET is_person = true
WHERE beneficiary_type = 'PFA' AND is_person = false
  AND (cif IS NULL OR LEFT(cif, 1) SIMILAR TO '[0-9XYZK]');

UPDATE entities SET is_person = false
WHERE is_person = true
  AND (name ~* '(S\.?L\.?U?\y|S\.?A\.?\y|S\.?C\.?C\.?L|S\.?COOP|FUNDACI|ASSOCI|EMPRESA|CORPORACI|SOCIETA|AJUNTAMENT|CONSELL|INSTITUT|CONSORCI|DIPUTACI|COOPERATIV|FEDERACI|S\.?C\.?P|HOSPITAL|UNIVERSIT|PATRONAT|UNICEF|UNRWA|,S\y|AUDIOVISUAL|GRUP\y|SERVEI|SDAD|COOP|LTDA)');

UPDATE entities SET is_person = true WHERE beneficiary_type = 'FSA';
