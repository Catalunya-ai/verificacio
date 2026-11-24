-- =====================================================================
-- Hand-checked expedient pairs (contract_expedient_aliases).
--
-- detect_contract_expedient_aliases() finds most aliases by rule on every
-- run. These four pairs are the ones a person checked against the official
-- records, and they must be in the table before the first aggregation:
--
--   * rule 'curated': the source publishes one 2021 contract of the
--     Ajuntament de Barcelona under two expedient codes; only the canonical
--     one counts.
--   * rule 'rejected': the rule-based detection would join these codes, but
--     the official records publish two different contracts; both count.
--
-- Values copied from the production schema. Idempotent.
-- =====================================================================

INSERT INTO public.contract_expedient_aliases (organ, alias_codi_expedient, canonical_codi_expedient, reason, rule)
VALUES
  ('Ajuntament de Barcelona', '20190001', '001/18000780',
   'La font publica el mateix contracte de 2021 sota dos expedients; només compta el canònic.', 'curated'),
  ('Ajuntament de Lleida', 'SUB_MEND_2025_0102-NGEU', 'SER_MEND_2025_0102-NGEU',
   'Rebutjat: els registres oficials publiquen dos contractes diferents; els dos expedients compten per separat.', 'rejected'),
  ('CALAFELL EMPRESA MUNICIPAL DE SERVEIS, SA', 'NVI.2023.01.01', 'JAR.2023.01.01',
   'Rebutjat: els registres oficials publiquen dos contractes diferents; els dos expedients compten per separat.', 'rejected'),
  ('Ajuntament de Tarragona', '2026/326-G626_1', '2026/326/G_626_1',
   'Rebutjat: els registres oficials publiquen dos contractes diferents; els dos expedients compten per separat.', 'rejected')
ON CONFLICT DO NOTHING;
