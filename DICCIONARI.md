# Diccionari de dades

Taules i camps que fan servir les xifres publicades: d'on surt cada camp (font oficial i camp d'origen) i quin pas del procés l'escriu. L'esquema complet és a [`sql/schema/010-tables.sql`](sql/schema/010-tables.sql).

Convencions:

- Imports en euros, amb dos decimals. Els contractes, **sense IVA**.
- Una fila amb `superseded = true` és una còpia o una anul·lació: es conserva, però **no compta** en cap total.
- *Pas* indica el fitxer que escriu el camp. Els connectors són a `src/connectors/`, el càlcul a `src/pipeline/`.

## Fonts oficials

| Font | Conjunt de dades | Connector | Taula |
|---|---|---|---|
| Registre d'Ajuts i Subvencions de Catalunya (RAISC) | [`s9xt-n979`](https://analisi.transparenciacatalunya.cat/resource/s9xt-n979.json) | `sync-raisc.ts` | `grants`, `entities` |
| Contractació pública a Catalunya | [`ybgg-dgi6`](https://analisi.transparenciacatalunya.cat/resource/ybgg-dgi6.json) | `sync-contractes.ts`, `sync-contract-annulments.ts` | `contracts`, `contract_official_annulments` |
| Execució del pressupost de la Generalitat (despeses) | [`ajns-4mi7`](https://analisi.transparenciacatalunya.cat/resource/ajns-4mi7.json) | `sync-pressupostos.ts` | `budget_transfers` |
| Convenis de la Generalitat | [`exh2-diuf`](https://analisi.transparenciacatalunya.cat/resource/exh2-diuf.json) | `sync-convenis.ts` | `convenis` |
| Registre d'Entitats de Catalunya | [`y6fz-g3ff`](https://analisi.transparenciacatalunya.cat/resource/y6fz-g3ff.json) | `enrich-accountability.ts` | `entities` (transparència) |
| Comptes de les entitats jurídiques (REJC) | [`tjhe-8syr`](https://analisi.transparenciacatalunya.cat/resource/tjhe-8syr.json) | `enrich-accountability.ts` | `entities`, `entity_financials_yearly` |
| Compliment d'obligacions dels ens locals | [`7fnj-etev`](https://analisi.transparenciacatalunya.cat/resource/7fnj-etev.json) | `enrich-accountability.ts` | (senyal opcional) |
| Sindicatura de Comptes, Informe 3/2024, quadre 13 | [PDF](https://www.sindicatura.cat/documents/36414/85841/2024_03_ca.pdf) | `seed-accio-concertada-sindicatura.ts` (xifres transcrites) | `accio_concertada` |
| Comarques i províncies (codis oficials) | — | `seed-territorial-mapping.ts` (taula fixa) | `territorial_mapping` |

## `grants` — subvencions (RAISC)

Una fila per concessió. Pas: `sync-raisc.ts` (`mapToGrant` a `src/lib/raisc-helpers.ts`).

| Camp | Significat | Origen (camp RAISC) |
|---|---|---|
| `raisc_clau` | Clau única del registre; un rellançament no la duplica | `clau` |
| `amount` | Import concedit. Les files amb import ≤ 0 no es carreguen | `import_subvenci_pr_stec_ajut` |
| `grant_date` | Data de concessió | `data_concessi` |
| `grant_year` | Any de la concessió; si no n'hi ha, any de la convocatòria. Fora de 2016–2030, la fila no es carrega | `data_concessi`, `any_de_la_convocat_ria` |
| `department` | Departament o ens local d'adscripció de l'òrgan que concedeix | `departament_o_entitat_local_d_adscripci_` (o `entitat_oo_aa_o_departament_1`) |
| `finalitat_rais` / `purpose` | Finalitat RAISC (categoria de la dominància) | `finalitat_rais` |
| `sub_purpose` | Subfinalitat | `subfinalitat` |
| `finalitat_publica` | Finalitat pública | `finalitat_p_blica` |
| `convocatoria` | Títol de la convocatòria (classifica la concessió com a competitiva als organismes atorgants) | `t_tol_convocat_ria_catal` |
| `cif` | CIF del beneficiari. Buit per a beneficiaris no publicables i persones físiques | `cif_beneficiari` |
| `beneficiary_type_code` | Tipus de beneficiari (PFA, FSA, JSA...) | `tipus_de_beneficiaris_codi` |
| `is_credit` | Crèdit oficial de l'ICF (préstec retornable): es compta a part, mai com a subvenció | `finalitat_rais = 'CRÈDIT OFICIAL I SUPORT FINANCER'` |
| `is_state_aid` | Ajut d'Estat | `ajut_d_estat` |
| `source_dataset`, `ccaa_code` | Sempre `raisc_concessions` i `CAT` | — |
| `entity_id`, `entity_slug` | Beneficiari (per CIF primer, per nom normalitzat si no hi ha CIF) | `ra_social_del_beneficiari`, `cif_beneficiari` |
| `superseded` | Fila que no compta (fusió d'entitats) | `consolidate-entities.ts` |

Els beneficiaris que el registre marca com a *Benef. no publicable*, i les persones físiques (tipus FSA amb un nom que no és genèric), s'agrupen en una entitat anònima per departament i no s'identifiquen mai.

## `contracts` — contractes públics

Una fila per expedient, adjudicatari i lot. Pas: `sync-contractes.ts`.

| Camp | Significat | Origen (camp del conjunt `ybgg-dgi6`) |
|---|---|---|
| `amount` | Import d'adjudicació **sense IVA**. Mai no es barreja amb l'import amb IVA | `import_adjudicacio_sense` |
| `amount_with_vat` | Import amb IVA (només informatiu) | `import_adjudicacio_amb_iva` |
| `contract_date`, `contract_year` | Data d'adjudicació; si no n'hi ha, de formalització; si no, de publicació | `data_adjudicacio_contracte`, `data_formalitzacio_contracte`, `data_publicacio_contracte` |
| `codi_expedient`, `lot_number` | Expedient i lot | `codi_expedient`, `numero_lot` |
| `organ` | Òrgan de contractació | `nom_organ` |
| `contract_type` | Obres, Serveis, Subministraments... | `tipus_contracte` |
| `procedure_type` | Procediment (obert, contracte menor, negociat sense publicitat...) | `procediment` |
| `num_bidders` | Ofertes rebudes | `ofertes_rebudes` |
| `cpv_code` | Codi CPV (els 3 primers dígits fan la categoria de la dominància) | `codi_cpv` |
| `cif`, `entity_id` | Adjudicatari. El codi desa l'identificador fiscal tal com la font oficial el publica, també el dels adjudicataris autònoms (persones físiques que contracten com a autònoms) quan la font l'inclou; els identificadors emmascarats no es desen. Publicar aquests identificadors no és la finalitat d'aquest repositori: qui l'utilitzi ha de complir la normativa de protecció de dades | `identificacio_adjudicatari`, `denominacio_adjudicatari` |
| `superseded` | Còpia o anul·lació que no compta: mateix contracte publicat dues vegades, fila resum d'un expedient amb lots, expedient àlies (`contract_expedient_aliases`) o anul·lació oficial (`contract_annulment_decisions`) | `aggregate-stats.ts` (pas 3b), `sync-contract-annulments.ts` |

## `entities` — beneficiaris i el seu *score*

Una fila per beneficiari. Identitat: el CIF quan n'hi ha; si no, el nom normalitzat (`slug`).

**Totals** (pas: `aggregate-stats.ts`; sempre sobre files que no són `superseded`):

| Camp | Càlcul |
|---|---|
| `total_amount`, `total_grants` | Suma i nombre de subvencions RAISC, **sense** crèdits ICF |
| `first_grant_year`, `last_grant_year` | Primer i darrer any amb subvenció |
| `total_credit_amount`, `total_credits` | Crèdits ICF, a part |
| `total_contract_amount`, `total_contracts` | Suma i nombre de contractes adjudicats |
| `total_budget_transfers` | Obligacions reconegudes de transferències corrents i de capital (capítols 4 i 7) del pressupost de la Generalitat atribuïdes a l'entitat |
| `total_equity_contributions` | Aportacions de capital (capítol 8, article 87) |
| `total_accio_concertada` | Acció concertada (Sindicatura de Comptes) |
| `total_conveni_amount`, `total_convenis` | Convenis. **No** entren als fons públics totals |
| `total_public_funds` | `total_amount + total_contract_amount + total_budget_transfers + total_accio_concertada + total_equity_contributions` |
| `primary_organ`, `primary_contract_type` | Òrgan i tipus de contracte més freqüents |

**Xarxa de contractes** (pas: `analyze-contract-network.ts`):

| Camp | Càlcul |
|---|---|
| `sole_source_count`, `sole_source_amount`, `sole_source_pct` | Contractes amb un sol licitador, contracte menor o negociat sense publicitat |
| `fragmentation_count` | Contractes a la franja 14.900–15.000 € (només si n'hi ha 3 o més) |
| `fragmentation_risk` | `fragmentation_count` com a % dels contractes de l'entitat |

**Transparència comptable** (pas: `enrich-accountability.ts`):

| Camp | Càlcul |
|---|---|
| `files_accounts`, `account_years`, `latest_account_year` | Dipòsits de comptes al REJC |
| `in_official_registry` | L'entitat consta al Registre d'Entitats |
| `accountability_ratio` | Mitjana ponderada de 5 senyals (dipòsit 35%, actualitat 20%, cobertura 25%, registre 15%, ens locals 5% opcional) |
| `score_accountability` | `100 − accountability_ratio` per a les entitats obligades (associacions d'utilitat pública i fundacions) i per a les que dipositen voluntàriament; NULL per a la resta |

**Score Menjòmetre v5.1** (pas: `calculate-scores-sql.ts`; tots els components de 0 a 100, valor alt = patró més marcat):

| Camp | Càlcul | Condició |
|---|---|---|
| `score_volume` | Percentil de `total_public_funds` entre les entitats elegibles | Elegible: no anonimitzada, ≥ 1 transacció i ≥ 25.000 € |
| `score_frequency` | Percentil de transaccions (subvencions + contractes) per any; el període va del primer al darrer any amb subvenció (vegeu més avall) | ≥ 100.000 € de fons públics |
| `score_dominance` | Percentil dins la finalitat principal (subvencions) i dins el CPV de 3 dígits principal (contractes), ponderats pel pes de cada font | Grup principal ≥ 100.000 € i ≥ 10 entitats al grup |
| `idx_market_competition` | % de l'import contractual classificable adjudicat sense competència (exclou el contracte menor sota el llindar legal de la LCSP i els contractes de classificació desconeguda) | ≥ 25.000 € classificables |
| `score_concurrencia` | `idx_market_competition`; amb fragmentació (≥ 5 contractes i ≥ 5%), 70% competència + 30% fragmentació | Com l'anterior |
| `score_accountability` | Vegeu més amunt | Opcional |
| `menjometre_score` | Mitjana aritmètica dels components que no són NULL | 0 per sota del llindar d'elegibilitat |

**Classificació** (pas: `sql/pipeline/010-classify-persons.sql`): `is_person` marca les persones físiques, que no compten en el nombre d'entitats ni surten al rànquing. `is_anonymized` marca els beneficiaris no publicables agrupats.

**Identitat i fusions** (passos: `consolidate-entities.ts`, `sql/pipeline/020-reconcile-entity-stubs.sql`, `sql/pipeline/030-reconcile-curated-aliases.sql`): quan una entitat buida (sense CIF, sense subvencions ni contractes) és un duplicat d'una entitat amb fons, s'hi fusiona. `slug_aliases` i `also_known_as` guarden els slugs i noms fusionats, `aka_norm` la seva forma normalitzada per a la cerca, `name_norm` el nom normalitzat (columna generada) i `alt_cifs` altres CIF coneguts de l'entitat. Les fusions no mouen cap import: només canvien el nombre d'entitats.

### Camps sense migració

Quatre camps de `entities` no apareixen a l'historial de migracions de la base de dades de producció, però el codi els llegeix o els escriu, i aquí es declaren amb el tipus que el codi espera:

- **`first_contract_year` i `last_contract_year`: encara no formen part de les xifres publicades.** Cap pas del procés no els omple, i queden a NULL. El càlcul de la freqüència els llegeix, però amb NULL el període d'activitat surt dels anys de les subvencions, i una entitat que només té contractes no rep component de freqüència.
- **`score_frequency`** sí que és una xifra publicada: és el component de freqüència del *score*, que escriu `calculate-scores-sql.ts`. Només li falta la migració que la creï.
- **`cif_aliases`** no forma part de les xifres publicades: la fusió de duplicats buits només la consulta com a salvaguarda (no fusiona si una redirecció apunta a un altre CIF que no hi figura), i cap pas no l'omple.

## `entity_yearly_stats` — sèrie anual per entitat

Pas: `aggregate-stats.ts` (passos 2 i 6). Una fila per entitat i any.

| Camp | Càlcul |
|---|---|
| `total_amount`, `grant_count` | Subvencions de l'any, sense crèdits ICF (mateix filtre que `entities.total_amount`) |
| `contract_amount`, `contract_count` | Contractes de l'any |
| `departments`, `purposes` | Departaments i finalitats de l'any |

## Taules de suport

| Taula | Contingut | Pas |
|---|---|---|
| `budget_transfers` | Línies de transferència del pressupost de la Generalitat (desembre de cada exercici), atribuïdes a una entitat per una taula de correspondències revisada a mà i pel nom | `sync-pressupostos.ts` |
| `accio_concertada` | Import per entitat i any (milers d'euros de l'informe, desats en euros) | `seed-accio-concertada-sindicatura.ts` |
| `convenis` | Convenis i aportacions previstes | `sync-convenis.ts` |
| `contract_expedient_aliases` | Parelles d'expedients que són el mateix contracte (detectades per regla, o revisades a mà) i parelles rebutjades | `sql/curation/`, `detect_contract_expedient_aliases()` |
| `contract_official_annulments` | Línies d'anul·lació oficials del conjunt `ybgg-dgi6` | `sync-contract-annulments.ts` |
| `contract_annulment_decisions` | Decisió per contracte afectat (no compta / torna a comptar / es manté) amb la raó i l'evidència | `sync-contract-annulments.ts` |
| `entity_financials_yearly` | Ingressos, subvencions rebudes i cost de personal dels comptes dipositats | `enrich-accountability.ts` |
| `entity_connections` | Senyals de la xarxa de contractes (finançador compartit, adjudicació directa repetida) | `analyze-contract-network.ts` |
| `slug_redirects`, `entity_merge_log` | Rastre de les fusions d'entitats | `consolidate-entities.ts`, `sql/pipeline/020`, `030` |
| `entities_stubmerge_bak_*`, `stub_merge_fk_bak_*`, `stub_merge_log_*` | Còpies de seguretat i registre de cada fusió de duplicats buits (una per execució) | `sql/pipeline/020`, `030` |
| `territorial_mapping` | Codi territorial RAISC → comarca i província | `seed-territorial-mapping.ts` |
| `data_sync_log` | Registre de les càrregues | connectors |

## Vistes materialitzades

| Vista | Contingut |
|---|---|
| `contract_yearly_stats_mv` | Contractes per any i tipus |
| `yearly_totals_mv` | Totals anuals de subvencions i contractes (suma de `entity_yearly_stats`) |
| `grant_organ_mv` | Per departament atorgant: import, beneficiaris, % de concessions per convocatòria, % de prestacions i semàfor (només departaments amb ≥ 10 concessions i ≥ 100.000 €) |
| `grant_organ_yearly_mv`, `grant_organ_finalitat_mv`, `grant_organ_beneficiaris_mv` | El mateix per any, per finalitat i principals beneficiaris |

Les refresca `aggregate-stats.ts` (pas 8). Les consultes de `sql/queries/` les fan servir per reproduir les xifres.
