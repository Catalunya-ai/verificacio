# Catalunya.ai: codi de verificació

**El codi que calcula el *score* i les xifres de subvencions, contractes i organismes atorgants és obert (AGPL-3.0-or-later): és aquest repositori.** Aquest repositori conté el codi per reproduir i auditar, a partir de les fonts oficials obertes, aquestes xifres que Catalunya.ai publica a [catalunya.ai](https://catalunya.ai): els imports per beneficiari, els totals, les sèries anuals, l'anàlisi dels organismes atorgants i el *score* Menjòmetre. La resta de xifres del portal no hi són.

Catalunya.ai és una iniciativa del Menjòmetre.

Hi trobareu:

- la [metodologia](METODOLOGIA.md) i el [diccionari de dades](DICCIONARI.md);
- els connectors que descarreguen les dades de les fonts oficials (`src/connectors/`);
- el codi i la configuració de l'agregació i del *score* (`src/pipeline/`, `src/lib/scoring-config.ts`);
- l'esquema de la base de dades i les funcions SQL (`sql/schema/`, `sql/matviews/`);
- les consultes que reprodueixen aquestes xifres (`sql/queries/`);
- els tests (`tests/unit/`).

## Què no és

- **No és el producte.** El portal web, el servidor MCP, l'assistent, els pagaments, els comptes d'usuari i la infraestructura de catalunya.ai són privats i no hi són.
- **No conté dades.** Les dades es descarreguen de les fonts oficials amb els connectors, a una base de dades PostgreSQL vostra.
- **No és una còpia de la base de dades de producció.** Les fonts oficials s'actualitzen contínuament: una descàrrega d'avui pot diferir en part de la que va produir una xifra publicada fa setmanes.

## Fonts oficials

| Font | Publicador | Enllaç |
|---|---|---|
| Registre d'Ajuts i Subvencions de Catalunya (RAISC) | Generalitat de Catalunya | [s9xt-n979](https://analisi.transparenciacatalunya.cat/resource/s9xt-n979.json) |
| Contractació pública a Catalunya | Generalitat de Catalunya | [ybgg-dgi6](https://analisi.transparenciacatalunya.cat/resource/ybgg-dgi6.json) |
| Execució del pressupost de la Generalitat (despeses) | Generalitat de Catalunya | [ajns-4mi7](https://analisi.transparenciacatalunya.cat/resource/ajns-4mi7.json) |
| Convenis de la Generalitat | Generalitat de Catalunya | [exh2-diuf](https://analisi.transparenciacatalunya.cat/resource/exh2-diuf.json) |
| Registre d'Entitats de Catalunya | Generalitat de Catalunya | [y6fz-g3ff](https://analisi.transparenciacatalunya.cat/resource/y6fz-g3ff.json) |
| Comptes de les entitats jurídiques (REJC) | Generalitat de Catalunya | [tjhe-8syr](https://analisi.transparenciacatalunya.cat/resource/tjhe-8syr.json) |
| Compliment d'obligacions dels ens locals | Generalitat de Catalunya | [7fnj-etev](https://analisi.transparenciacatalunya.cat/resource/7fnj-etev.json) |
| Informe 3/2024 (acció concertada, quadre 13) | Sindicatura de Comptes | [PDF](https://www.sindicatura.cat/documents/36414/85841/2024_03_ca.pdf) |

Tots els conjunts de dades són del portal [Dades Obertes de Catalunya](https://analisi.transparenciacatalunya.cat) (API Socrata/SODA). L'informe de la Sindicatura és un PDF: les seves xifres estan transcrites a `src/connectors/seed-accio-concertada-sindicatura.ts`.

## Requisits

- Node.js 20, 22 o 24, i `npm`.
- PostgreSQL 13 o posterior (provat amb la 17), amb les extensions `unaccent` i `pg_trgm` (paquet *contrib*), i el client `psql` al `PATH`.
- Espai i temps: el RAISC té uns 19,5 milions de registres i els contractes, uns 1,7 milions. Una càrrega completa ocupa desenes de GB i dura hores.

## Connexió

Per a la connexió, tots els scripts llegeixen **una sola variable d'entorn**, `DATABASE_URL`, que apunta a la vostra base de dades:

```bash
export DATABASE_URL=postgres://usuari:contrasenya@localhost:5432/menjometre
export SODA_APP_TOKEN=...   # opcional: el fan servir la càrrega del RAISC i la de transparència comptable
```

Cap script no llegeix fitxers `.env`, ni es connecta a cap altre servidor que la vostra base de dades i les fonts oficials. `psql` rep la connexió per variables `PG*`, mai per la línia d'ordres. Vegeu `config.example`.

## Com reproduir les xifres, pas a pas

Totes les ordres s'executen des de l'arrel del repositori.

```bash
# 0. Dependències
npm ci

# 1. Esquema, funcions, vistes materialitzades i parelles d'expedients revisades
npm run sql -- sql/install.sql
npx tsx src/connectors/seed-territorial-mapping.ts

# 2. Càrregues que producció fa amb el seu propi calendari (vegeu més avall):
#    transferències del pressupost, acció concertada i convenis
npx tsx src/connectors/sync-pressupostos.ts --skip-aggregation
npx tsx src/connectors/seed-accio-concertada-sindicatura.ts
npx tsx src/connectors/sync-convenis.ts --full --skip-aggregation

# 3. Ordre del procés de producció, pas a pas
#  3.1 Subvencions (RAISC)
npx tsx src/connectors/sync-raisc.ts --full --skip-aggregation
#  3.2 Contractes públics
npx tsx src/connectors/sync-contractes.ts --full --skip-aggregation
#  3.3 Anul·lacions oficials de contractes (proveu primer amb --dry-run)
npx tsx src/connectors/sync-contract-annulments.ts
#  3.4 Fusió d'entitats per CIF (proveu primer amb --dry-run)
npx tsx src/pipeline/consolidate-entities.ts
#  3.5 Fusió de duplicats buits i àlies revisats a mà
npm run sql -- sql/pipeline/010-classify-persons.sql
npm run sql -- sql/pipeline/020-reconcile-entity-stubs.sql --single-transaction
npm run sql -- sql/pipeline/030-reconcile-curated-aliases.sql --single-transaction
#  3.6 Totals per entitat, sèries anuals i vistes materialitzades
npx tsx src/pipeline/aggregate-stats.ts
#      Transparència comptable (REJC): producció la carrega amb el seu propi
#      calendari; en una base nova, aquí, quan ja hi ha els anys de subvencions
npx tsx src/connectors/enrich-accountability.ts --full
#  3.7 Score Menjòmetre
npx tsx src/pipeline/calculate-scores-sql.ts
#  3.8 Senyals de la xarxa de contractes (fragmentació), després del score
npx tsx src/pipeline/analyze-contract-network.ts
#  3.9 Comprovacions
npx tsx src/pipeline/verify-raisc.ts
npx tsx src/pipeline/verify-stats.ts
```

**L'ordre és el de producció.** Els passos 3.1–3.9 segueixen el procés de refresc de producció, i dos d'ells fan servir el que va deixar l'execució anterior: la fusió de duplicats buits (3.5) només fusiona cap a entitats que ja tenen fons públics totals (els calcula 3.6), i el *score* (3.7) fa servir la fragmentació que calcula la xarxa de contractes (3.8), que va **després**. Producció ja té aquests valors de l'execució anterior. En una base nova, **executeu els passos 3.4–3.8 dues vegades** per arribar al mateix estat.

**Càrregues amb calendari propi.** Producció no carrega les transferències del pressupost, l'acció concertada, els convenis ni la transparència comptable dins d'aquest procés, sinó quan s'actualitzen les fonts; els totals i el *score* fan servir el que hi ha a la base en aquell moment. En una base nova cal carregar-les on indica el bloc anterior.

**Persones físiques.** Producció va aplicar la regla de `sql/pipeline/010-classify-persons.sql` una sola vegada, el març del 2026, amb migracions de dades; aquí es fa abans de la fusió de duplicats buits, que la necessita per excloure les persones físiques.

Els connectors també escriuen alguns totals provisionals quan s'executen sense `--skip-aggregation`; el pas 3.6 els recalcula tots i és l'únic que compta.

### Reproduir una xifra concreta

| Xifra publicada | Consulta |
|---|---|
| Totals de la portada (subvencions, contractes, entitats, entitats amb *score*) | `npm run sql -- sql/queries/01-xifres-portada.sql` |
| Fitxa d'una entitat: imports per canal i components del *score* | `npm run sql -- sql/queries/02-fitxa-entitat.sql id=<CIF o slug>` |
| Sèrie anual d'una entitat (i la mateixa sèrie recalculada des de les files) | `npm run sql -- sql/queries/03-serie-anual-entitat.sql id=<CIF o slug>` |
| Rànquing per *score* | `npm run sql -- sql/queries/04-ranking-score.sql` |
| Comprovació del *score* (la mitjana dels components dona el valor desat) i bandes | `npm run sql -- sql/queries/05-comprovacio-score.sql` |
| Organismes atorgants i semàfor | `npm run sql -- sql/queries/06-organs-atorgants.sql` |
| Totals per any | `npm run sql -- sql/queries/07-totals-anuals.sql` |

El `slug` d'una entitat és la darrera part de l'adreça de la seva fitxa. Per exemple, per comprovar la fitxa d'una fundació amb CIF G12345678:

```bash
npm run sql -- sql/queries/02-fitxa-entitat.sql id=G12345678
```

El resultat mostra els imports de subvencions, contractes, transferències i acció concertada, els fons públics totals i els cinc components del *score*, que s'han de correspondre amb els de la fitxa pública (amb les diferències de data de descàrrega que s'expliquen més amunt).

## Diferències conegudes amb el càlcul de producció

- **Persones físiques.** Producció va aplicar la classificació de `sql/pipeline/010-classify-persons.sql` una sola vegada (març del 2026); aquí s'aplica a totes les files. Pot canviar el nombre d'entitats de la portada, no els imports.
- **Accés a la base de dades.** El RAISC i les taules de suport es carregaven a través d'una API REST; aquí van directament a PostgreSQL amb les mateixes regles d'identitat (CIF primer, nom normalitzat si no n'hi ha). Els camps geogràfics d'una entitat només s'actualitzen quan la fila d'origen en porta.
- **Vistes materialitzades.** Només s'inclouen les que sostenen xifres publicades i depenen d'aquestes taules. Les xifres de la portada que compten altres bases del portal (càrrecs públics, documents...) no es reprodueixen.
- **Quatre camps** de `entities` no tenen migració a l'historial de producció; vegeu el [diccionari](DICCIONARI.md#camps-sense-migració).

## Tests

```bash
npm test          # tests unitaris: sense xarxa i sense base de dades
npm run typecheck # comprovació de tipus de tot el codi
```

Els tests comproven, entre altres coses, que l'SQL del *score* aplica exactament els llindars de `src/lib/scoring-config.ts` i que la metodologia en diu la mateixa versió i la mateixa franja de fragmentació.

## Estructura

```
src/connectors/   descàrrega de les fonts oficials i càrrega a PostgreSQL
src/pipeline/     fusió d'entitats, agregació, xarxa de contractes, score i comprovacions
src/lib/          funcions compartides (identitat d'entitats, CIF, privadesa, configuració del score)
sql/schema/       taules, índexs i funcions SQL
sql/curation/     correccions revisades a mà contra els registres oficials
sql/matviews/     vistes materialitzades de les xifres publicades
sql/pipeline/     passos del procés en SQL (persones físiques, duplicats buits, àlies revisats a mà)
sql/queries/      consultes per reproduir les xifres
tests/unit/       tests unitaris
```

## Llicència

Copyright (C) 2026 Feeder LLC

AGPL-3.0-or-later. Vegeu [LICENSE](LICENSE) i [NOTICE](NOTICE). Si modifiqueu aquest codi i l'oferiu com a servei a través d'una xarxa, heu de publicar-ne les modificacions amb la mateixa llicència.

---

## English

**The code that computes the score and the figures for grants, contracts and granting bodies is open (AGPL-3.0-or-later): it is this repository.** This repository holds the code to reproduce and audit, from the official open data, these figures that Catalunya.ai publishes on [catalunya.ai](https://catalunya.ai): amounts per beneficiary, totals, yearly series, the granting-body analysis and the Menjòmetre score. Other figures of the site are not covered.

Catalunya.ai is an initiative of the Menjòmetre.

It is **not** the product: the website, MCP server, assistant, billing, accounts and infrastructure are private and not included. It ships **no data**: the connectors download it from the official sources (table above) into a PostgreSQL database of your own.

Quick start: set `DATABASE_URL` to your PostgreSQL 13+ database (with the `unaccent` and `pg_trgm` extensions and `psql` available), run `npm ci`, then follow the numbered steps above. Steps 3.1–3.9 follow the production refresh order exactly (loads → consolidation → stub and alias reconciliation → aggregation → score → contract network). Use the queries in `sql/queries/` to reproduce a specific figure, e.g. `npm run sql -- sql/queries/02-fitxa-entitat.sql id=<CIF>`. `npm test` runs the unit tests (no network, no database). The methodology ([METODOLOGIA.md](METODOLOGIA.md)) and the data dictionary ([DICCIONARI.md](DICCIONARI.md)) are in Catalan.

Copyright (C) 2026 Feeder LLC. Licence: AGPL-3.0-or-later (see LICENSE and NOTICE).
