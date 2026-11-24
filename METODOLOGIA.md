# Metodologia

Aquest document parteix del text de la pàgina pública [catalunya.ai/metodologia](https://catalunya.ai/metodologia) tal com era el 23 de novembre de 2026, convertit a Markdown, i **descriu el que fa el codi d'aquest repositori**. Allà on la pàgina web no ho descrivia exactament (els fons públics totals, la BDNS, el volum, la freqüència, la dominància, la concurrència, la transparència comptable i el semàfor dels organismes atorgants), el text s'ha corregit perquè digui el que fa el codi. S'han tret els elements de navegació del web i els crèdits.

**Què reprodueix el codi d'aquest repositori.** Les seccions *Fonts de dades* (RAISC, contractes públics, pressupost i acció concertada), *Com es processen les dades*, *Classificació d'entitats*, *Patrons contractuals*, *Algorisme de score*, *Categories de score* i el semàfor de distribució d'*Anàlisi d'organismes atorgants*. Les seccions marcades amb la nota "No ho calcula aquest repositori" descriuen altres parts del portal. Vegeu el [README](README.md) per reproduir les xifres pas a pas i el [DICCIONARI](DICCIONARI.md) per als camps.

Els valors exactes de pesos i llindars són a [`src/lib/scoring-config.ts`](src/lib/scoring-config.ts) i el càlcul, a [`src/pipeline/calculate-scores-sql.ts`](src/pipeline/calculate-scores-sql.ts). Els tests de `tests/unit/scoring-sql.test.ts` i `tests/unit/fragmentation-band.test.ts` comproven que l'SQL aplica els llindars de la configuració, i que aquest text en diu la versió i la franja de fragmentació.

---

El *score* Menjòmetre és un **índex de concentració estadística**. Mesura el grau en què una entitat destaca estadísticament per volum de fons públic, freqüència de transaccions i posició relativa dins la seva categoria temàtica, comparada amb la resta d'entitats del sistema.

Un *score* alt indica que els criteris estadístics aplicats situen l'entitat per sobre de la mitjana en un o més eixos. **No indica cap irregularitat, mal ús ni valoració moral sobre l'entitat.** Universitats que reben recerca any rere any, grans ajuntaments que canalitzen fons cap al territori, o hospitals que concentren fons sanitaris obtindran *scores* alts pels seus patrons de recepció de fons públics, patrons completament normals per a entitats d'aquesta naturalesa.

> Volum i freqüència utilitzen percentils; la dominància combina percentils dins de cada grup. Concurrència i transparència comptable són components absoluts. La mitjana final no és un percentil de la població. Els pesos i els llindars vigents es documenten en aquest document.

## Fonts de dades

### 1. RAISC: Font primària

El **Registre d'Ajuts i Subvencions de Catalunya** és la font principal amb ~19,5 milions de registres (2016–2026). Proveeix CIF del beneficiari, geografia (comarca, província, vegueria), tipologia del beneficiari, jerarquia de finalitats a 3 nivells, i codi BDNS. Publicat per la Generalitat de Catalunya.

### 2. BDNS: No entra al càlcul

La **Base de Datos Nacional de Subvenciones** no forma part del càlcul d'aquest repositori: no hi ha cap connector de la BDNS, i l'agregació compta només les subvencions del RAISC (i qualsevol altra fila amb codi de comunitat `CAT`) que no estiguin marcades com a substituïdes.

### 3. Dades Obertes de Catalunya: Contractes públics

~1,7 milions de contractes públics (2015–2026), la mateixa font que [contractes.cat](https://contractes.cat). Inclou CIF adjudicatari, tipus de contracte, procediment d'adjudicació i import sense IVA. S'integren al *score* Menjòmetre i al càlcul de fons públics totals.

### 4. Acció concertada: Serveis socials

Despesa pública canalitzada via **acció concertada** (Llei 12/2007, Decret 69/2020), el mecanisme pel qual la Generalitat externalitza serveis socials (CRAE, pisos assistits, primera acollida) a entitats del tercer sector sense licitació pública convencional. Aquesta font **no apareix** ni al RAISC (subvencions) ni als contractes públics, és un canal de finançament diferent.

Font actual: [Sindicatura de Comptes, Informe 3/2024](https://www.sindicatura.cat/documents/36414/85841/2024_03_ca.pdf) (Quadre 13), cobreix la despesa DGAIA en atenció a la infància i l'adolescència per a 23 entitats principals (2016–2020), ~757M EUR. Segons la Sindicatura, l'acció concertada representa el 87% de la despesa total de la DGAIA en aquest àmbit.

L'acció concertada s'integra al càlcul de *fons públics totals* de cada entitat i, per tant, entra al component de **volum** del *score*. No entra a la freqüència, a la dominància ni a la concurrència, que es calculen amb subvencions i contractes, i per si sola no fa elegible una entitat: cal almenys una subvenció o un contracte. 

### 5. Pressupost de la Generalitat: Transferències i aportacions de capital

Del conjunt de dades d'execució mensual del pressupost de la Generalitat (despeses, `ajns-4mi7`), les obligacions reconegudes a desembre de cada exercici dels capítols 4 i 7 (transferències corrents i de capital) i del capítol 8, article 87 (aportacions de capital), atribuïdes a una entitat concreta per una taula de correspondències revisada a mà i pel nom. Les línies genèriques que no es poden atribuir a una sola entitat (participació dels ajuntaments, a famílies, concerts educatius...) no es carreguen.

## Evolució anual de fons a la premsa

> **No ho calcula aquest repositori.** Aquesta secció descriu una altra part del portal; es manté perquè el text de la metodologia sigui complet.

El gràfic d'evolució anual de la pàgina [Fons públics a la premsa](https://catalunya.ai/premsa) agrega per any els fons rebuts pels mitjans de comunicació identificats, descomposats en tres fonts independents. Cada font té el seu propi cicle de publicació, i les xifres dels anys més recents són sempre provisionals fins que les administracions tanquen i publiquen els exercicis.

### Fonts agregades

- **Subvencions:** Registre d'Ajuts i Subvencions de Catalunya (RAISC), publicat per la Generalitat al portal de [Dades Obertes de Catalunya](https://analisi.transparenciacatalunya.cat) (dataset s9xt-n979).
- **Contractes:** Registre Públic de Contractes (RPC) de la Generalitat, distribuït a través de Dades Obertes de Catalunya (dataset ybgg-dgi6), la mateixa font que [contractes.cat](https://contractes.cat). Imports sense IVA.
- **Publicitat institucional:** declaracions d'inversió publicitària de dues administracions catalanes:
  - Generalitat de Catalunya, dataset [8d5a-6vsk](https://analisi.transparenciacatalunya.cat/Sector-P-blic/Despeses-en-publicitat-institucional/8d5a-6vsk/) (publicació trimestral, anys 2015-2024 disponibles).
  - Ajuntament de Barcelona: Open Data BCN (anys 2010-2024). Resol el cost a nivell de campanya i tipus de mitjà però no sempre identifica el suport concret, per la qual cosa una part dels imports queda classificada per categoria sense ser atribuïda a un mitjà concret.

L'Administració General de l'Estat es publica només a nivell agregat per ministeri (Pla anual de publicitat i comunicació institucional, sense desglossament per mitjà), motiu pel qual no s'ha integrat com una quarta font: la dada existent no permet atribuir-la a cap entitat receptora. Els exercicis més recents (2025 i posteriors) apareixen sense aquesta tercera font fins que els organismes publiquin el dataset corresponent, la Generalitat ho fa amb mesos de retard respecte a l'exercici tancat.

### Per què hi ha anys marcats com a parcials

Cada font actualitza el seu dataset entre el primer i el segon trimestre de l'exercici següent al tancament: els organismes han de tancar comptes, validar imports finals i només llavors publiquen el dataset complet. Això vol dir que les xifres dels últims un o dos anys creixen durant els mesos posteriors al tancament fins a estabilitzar-se.

Per fer visible aquest desfasament i evitar lectures errònies, el gràfic marca un any com a *parcial* quan compleix les dues condicions següents:

- L'any cau dins la finestra dels dos anys més recents de la sèrie (els anteriors es consideren estables).
- Almenys una de les tres fonts era present a l'any anterior i és absent a l'any en curs, un patró típic de retard de publicació, no de canvi real al sector.

Els anys parcials apareixen amb columnes ratllades i opacitat reduïda, no es connecten amb la línia de total anual, i no generen l'etiqueta de variació interanual. Anys més antics als quals simplement no s'hi va recollir alguna font (per exemple, perquè l'abast de Menjòmetre encara no la cobria) *no* es marquen com a parcials, la seva absència té un origen diferent (manca d'abast, no retard de publicació).

### Cobertura temporal: per què hi ha menys dades pre-2020

El gràfic d'evolució anual mostra columnes molt més altes a partir del 2020-2021. Aquest salt no reflecteix un canvi en la despesa real cap a la premsa, sinó **el moment en què cada portal d'origen va començar a publicar el registre en format obert i amb cobertura completa**. La verificació contra fonts oficials (Departament d'Economia, Llei 19/2014, Llei 9/2017, Decret 271/2019, Decret 40/2025) ho confirma.

- **RAISC (subvencions):** creat per la [Llei 19/2014 de transparència](https://www.gencat.cat/eapc/revistes/RCDP/dossier/RCDP_60/Normativa/llei_19_2014.pdf) i operacionalitzat per la Llei 5/2017, però el [Decret 271/2019](https://economia.gencat.cat/ca/detalls/article/Decret-271-2019) que en regula la publicació en obert només entra en vigor a finals de desembre de 2019, amb un *any de transitorietat* per a les administracions. La conseqüència mecànica: 2016–2019 són càrregues voluntàries i parcials; 2020 és el primer any amb obligació plena, i el 2021 la sèrie s'estabilitza.
- **RPC (contractes):** el registre existia com a tal pre-2018, però l'estàndard mínim de publicació en format obert el reforça la [Llei 9/2017 de contractes del sector públic](https://portaljuridic.gencat.cat/ca/document-del-pjur/?documentId=824435) (en vigor el 9 de març de 2018), coincideix amb el primer salt observat. El segon salt (2022 → 2023) correspon a la integració del registre amb el Consorci AOC i a l'adhesió d'administracions menors.
- **Publicitat institucional:** obligada a publicar des del 2000 per la [Llei 18/2000](https://portaljuridic.gencat.cat/ca/document-del-pjur/?documentId=247164), la Generalitat publica el dataset 8d5a-6vsk en format obert des del 2015 i l'Ajuntament de Barcelona des del 2012 (Iniciativa Open Data BCN, una de les més antigues d'Espanya). **És l'única de les tres fonts amb cobertura completa per tot el període mostrat**: al gràfic anual ho podeu observar perquè els segments violetes (publicitat institucional) tenen continuïtat al llarg de tota la sèrie, mentre que blau (subvencions) i ataronjat (contractes) creixen seguint el calendari legal de cada portal.

Implicació: si comparem dos anys i l'import sembla que ha pujat molt entre l'un i l'altre, **cal mirar primer si el salt coincideix amb una data legal** de la taula de més amunt. Si hi coincideix, la inflexió és del portal i no canvi de política. Si no, és un canvi real de despesa pública.

## Índex de dependència dels mitjans

> **No ho calcula aquest repositori.** Aquesta secció descriu una altra part del portal; es manté perquè el text de la metodologia sigui complet.

El percentatge compara el diner públic atribuït al mitjà en l'exercici de comptes disponible amb les vendes anuals dels comptes anuals dipositats al Registre Mercantil. El numerador recull les mateixes fonts que suma la pàgina [Fons públics a la premsa](https://catalunya.ai/premsa), subvencions, contractes i publicitat institucional, però imputades a l'exercici dels comptes, no a l'any seleccionat al rànquing. Per això la xifra de la columna Total i la de la columna % dependència poden correspondre a anys diferents.

El numerador inclou només el diner públic de les fonts que cobreix el Menjòmetre: Generalitat i món local català (RAISC i registre de contractes), publicitat institucional de la Generalitat i de l'Ajuntament de Barcelona, i subvencions estatals via BDNS. Fons públics d'altres administracions o instruments fora d'aquests registres (altres comunitats, fons europeus, publicitat estatal o municipal no publicada per capçalera) no hi són: el percentatge real pot ser més alt, mai més baix.

Un percentatge alt no implica irregularitat, frau ni cap conclusió sobre la línia editorial: és una ràtio descriptiva sobre el pes relatiu del finançament públic. Els imports públics s'atribueixen per any d'adjudicació o publicació i no sempre coincideixen amb l'execució comptable o el reconeixement d'ingressos del mateix exercici; per això poden aparèixer valors superiors al 100%.

## Com es processen les dades

Les dades de les fonts es creuen per CIF (identificador fiscal) per consolidar tota la informació d'una mateixa entitat en una sola fitxa; quan no hi ha CIF, pel nom normalitzat. Les subvencions que compten són les del RAISC no marcades com a substituïdes. L'acció concertada utilitza un canal legal diferent (Llei 12/2007 vs Llei General de Subvencions), per la qual cosa no hi ha solapament amb RAISC ni contractes.

El camp **fons públics totals** suma, per entitat: subvencions del RAISC **sense** els crèdits de l'ICF + contractes adjudicats (sense IVA) + transferències del pressupost de la Generalitat (capítols 4 i 7) + aportacions de capital (capítol 8, article 87) + acció concertada. Els crèdits ICF (préstecs reemborsables) es comptabilitzen per separat i **no** formen part dels fons públics totals. Els convenis tampoc no hi entren.

Segons la pàgina web, per a les entitats classificades com a mitjans de comunicació el total de la fitxa inclou també la **publicitat institucional** rebuda (vegeu la secció ["Evolució anual de fons a la premsa"](#evolució-anual-de-fons-a-la-premsa)). Aquesta suma no és al camp de fons públics totals ni la calcula aquest repositori.

## Classificació d'entitats

Les persones físiques autònomes (~41.000 beneficiaris) estan **separades del rànquing principal** i són accessibles a la pestanya "Persones Físiques". El rànquing per defecte mostra només entitats jurídiques (associacions, fundacions, empreses, administracions). Es consideren persones físiques els beneficiaris de tipus RAISC *PFA* sense CIF d'empresa, llevat que el nom porti una marca d'organització (SL, SA, fundació, associació, ajuntament...), i tots els de tipus *FSA*.

## Etiquetes i categories

> **No ho calcula aquest repositori.** Aquesta secció descriu una altra part del portal; es manté perquè el text de la metodologia sigui complet.

Les entitats es classifiquen automàticament en categories mitjançant creuament amb registres oficials de la Generalitat i detecció per nom: **Tercer Sector** (empreses d'inserció, centres especials de treball, entitats socials), **Premsa** (mitjans de comunicació), **Fundacions**, **Observatoris** i **Administracions** (ens públics). Aquestes categories permeten filtrar el rànquing per comparar entitats de naturalesa similar.

## Patrons contractuals

A partir de les dades de contractació pública, es calculen indicadors estadístics complementaris que no formen part del *score* Menjòmetre però s'exposen a la fitxa de cada entitat:

**Adjudicació directa:** Contractes amb un sol licitador o amb procediment de tipus *Contracte menor* o *Negociat sense publicitat*.

**Fragmentació:** Contractes d'import igual o superior a 14.900 EUR i inferior a 15.000 EUR, just sota el llindar de licitació pública obligatòria de 15.000 EUR sense IVA (article 118.1 de la LCSP, Llei 9/2017). Es compten només quan l'entitat en té almenys 3; l'indicador és el percentatge que representen sobre tots els seus contractes.

**Finançadors compartits:** Òrgans que atorguen tant subvencions com contractes a la mateixa entitat.

## Xarxa de connexions

> **No ho calcula aquest repositori.** Aquesta secció descriu una altra part del portal; es manté perquè el text de la metodologia sigui complet.

La secció **Vincles** identifica persones vinculades a múltiples entitats receptores de subvencions. Les connexions es calculen a partir dels càrrecs declarats per les entitats, obtinguts del **Registre d'Entitats de Catalunya** (dataset obert de *Dades Obertes de Catalunya*) i del **BORME** (Boletín Oficial del Registro Mercantil). S'hi inclouen càrrecs de patronat, junta directiva, secretari, tresorer i similars, aproximadament 37.000 entitats estan enriquides amb aquesta informació.

**Persones compartides:** Quan el mateix nom apareix com a càrrec a dues o més entitats diferents, es crea una connexió de tipus "persona compartida". Això permet visualitzar xarxes de govern comú entre entitats.

**Filtre institucional:** Els patronats sovint inclouen institucions com a membres (p.ex. "Vocal: Generalitat de Catalunya"). Aquestes entitats institucionals es filtren automàticament i no apareixen com a persones. El filtre exclou noms que comencen per patrons institucionals reconeguts: Generalitat, Ajuntament, Diputació, Universitat, Fundació, Associació, Federació, Consorci, Institut, Patronat, entre d'altres.

**Filtres addicionals:** Noms amb menys de 5 caràcters després de normalitzar es descarten per evitar coincidències espúries (p.ex. inicials). Noms que apareixen a més de 10 entitats es descarten per evitar falsos positius per homonímia.

**Per què una persona pot no aparèixer?**

- L'entitat relacionada no figura al Registre d'Entitats de Catalunya (~300.000 entitats no tenen dades de càrrecs disponibles).
- El nom de la persona té menys de 5 caràcters després de normalitzar.
- El nom apareix a més de 10 entitats, es descarta per possible homonímia.
- El nom coincideix amb un patró institucional (Generalitat, Ajuntament, etc.) i es filtra automàticament.
- La persona només apareix a 1 entitat, cal aparèixer a 2 o més per generar una connexió de xarxa.
- Les dades del registre poden estar desactualitzades respecte la realitat actual de l'entitat.

Nota: Persones amb el mateix nom a diferents entitats poden no ser la mateixa persona física si no comparteixen CIF d'entitat. Les dades provenen de declaracions de les pròpies entitats i poden estar desactualitzades.

## Retribucions de càrrecs públics

> **No ho calcula aquest repositori.** Aquesta secció descriu una altra part del portal; es manté perquè el text de la metodologia sigui complet.

La secció **Política** integra dades retributives de càrrecs electes i alts càrrecs de les institucions catalanes. Les fonts de dades són:

### 1. Parlament de Catalunya

Retribucions dels 135 diputats i diputades, obtingudes de les declaracions d'activitats i béns publicades al web del Parlament. Cobertura: legislatures XII–XV (2017–2026).

### 2. Alts càrrecs de la Generalitat

Retribucions dels consellers, secretaris generals, directors generals i assimilats, publicades al Portal de Transparència de la Generalitat (dataset Transparentia). Cobertura: 2015–2026.

### 3. Diputacions provincials

Retribucions dels membres electes de les quatre diputacions catalanes (Barcelona, Girona, Lleida i Tarragona), extretes dels portals de transparència institucionals (seu-e.cat i diba.cat). Inclou 130 càrrecs amb dades salarials de 2024. Els càrrecs amb dedicació per assistències (sense salari fix anual) consten al registre però sense import retributiu.

### 4. BORME (Boletín Oficial del Registro Mercantil)

Càrrecs societaris (administradors, consellers, secretaris) de persones vinculades a entitats receptores de fons públics. ~86.000 persones amb 103.000 vincles empresa-càrrec.

Totes les retribucions publicades són imports bruts anuals, incloent-hi pagues extraordinàries quan la font les detalla. No es publiquen dades de caràcter personal (NIF/DNI) ni s'identifiquen persones físiques per cap identificador fiscal.

La cobertura salarial actual és del 13% dels càrrecs registrats. Això es deu al fet que la majoria de càrrecs provenen del BORME (consellers d'empreses) on la retribució no és pública. Per als càrrecs institucionals (Parlament, Generalitat, diputacions) la cobertura és superior al 80%.

### Com s'interpreten els anys de trajectòria registrada

La durada publicada resumeix els períodes registrats inclosos al còmput, fusionant els solapaments. El resum conserva els períodes de càrrecs públics i orgàniques de partit inclosos a les fonts del còmput; altres posicions, com les classificades sense dedicació, privades o honorífiques, poden constar a la cronologia sense sumar al resum. Aquesta selecció no acredita per si sola cap cobrament. La cobertura és parcial: no representa necessàriament tota la carrera de la persona. Les fonts electorals poden donar dates convencionals de mandat sense documentar baixes o substitucions.

Els anys de trajectòria no acrediten remuneració durant tot el període. No es publiquen puntuacions personals, categories de risc ni percentils basats en aquesta durada. Els llistats es poden ordenar per anys registrats sense que aquest ordre impliqui una valoració de la persona.

La remuneració requereix fonts pròpies i dates de referència. Una dada salarial d'un exercici no es pot estendre a tot un mandat. L'absència de dades significa remuneració no verificada, no un import de zero euros.

### Com s'atribueix el partit a cada càrrec

El partit que mostrem per a cada persona és el seu **partit propi**, i només en aquests dos casos:

- Electes: la llista per la qual va ser elegida. Les candidatures locals que formen part de la marca municipal d'un partit (Acord Municipal d'ERC, Candidatura de Progrés del PSC, Compromís Municipal de Junts, AMUNT de la CUP) compten per a aquest partit, segons el nom oficial registrat de la candidatura.
- Militància documentada: una correcció amb font pública, amb l'enllaç i la data de verificació, per a cada persona.

Quan una persona nomenada no té cap partit propi documentat, no li n'atribuïm cap. El govern que la va nomenar es mostra a part com a context (per exemple, "Nomenada pel Govern Illa (PSC)") i no compta per a cap partit en els recomptes ni en les puntuacions.

El govern del nomenament s'identifica per la data del decret (DOGC o acords de govern publicats) i el Govern vigent en aquella data (Mas, Puigdemont, Torra, Aragonès, Illa). Els càrrecs renovats o ratificats per un Govern posterior conserven el context del nomenament original, llevat que hi hagi un nou decret publicat al DOGC.

Limitacions: els càrrecs designats pel Parlament per supermajoria (CAC, CCMA) o per autoritats independents per llei (Intervenció General, Sindicatura de Comptes, Síndic de Greuges, APDCAT, ACCO) no són nomenaments d'un govern, encara que les dades administratives els vinculin a un departament.

### Cobertura de regidors i alcaldes

La cobertura de càrrecs locals (regidors, alcaldes, càrrecs de diputacions) és **parcial** i estem ampliant la integració. Estat actual:

- Mandats 2023–2027: cobertura raonable per a municipis >20.000 habitants via dataset oficial del Ministeri de Política Territorial.
- Mandats 2015–2019 i 2019–2023: alcaldes i regidors electes de les dades obertes de la Generalitat. Mandats anteriors: cobertura parcial.
- Municipis petits (<5.000 habitants): cobertura limitada i heterogènia.

Per aquesta raó, els recomptes de Regidors i Alcaldes a les fitxes de partit van marcats amb un asterisc. Les xifres han de llegir-se com a **mínim**, no com a total exhaustiu. La integració de nous datasets municipals és un treball en curs.

## Algorisme de *score* (Menjòmetre Score)

El *score* es compon de **fins a 5 indicadors amb pes igual**, cadascun valorat de 0 a 100. Es calcula la mitjana dels components amb dades: cadascun s'activa quan hi ha dades suficients i es compleixen els llindars. Un valor zero participa en la mitjana; un valor absent queda exclòs. Cada component actiu rep el mateix pes (1/N), de manera que cap dimensió domina l'índex.

| # | Component | Pes |
|---|---|---|
| 1 | Volum | 1/N |
| 2 | Freqüència | 1/N |
| 3 | Dominància | 1/N |
| 4 | Concurrència (opcional) | 1/N |
| 5 | Transparència comptable (opcional) | 1/N |

N = nombre de components actius per a l'entitat, d'1 a 5. Pes de cada component: 1/N. Versió configurada: v5.1.

**Per què pesos iguals?** L'objectiu de l'algorisme és identificar entitats que concentren volums significatius de fons públics de manera recurrent i amb baixa competència de mercat. El llindar mínim és de 25.000 EUR en fons públics. Els pesos iguals segueixen els estàndards internacionals de composició d'índexs (FMI, *Fazekas/CRI Corruption Risk Index*) i eviten que una calibració arbitrària determini el resultat final.

Quan un component opcional no aplica (concurrència sense prou contractes, o transparència comptable per a entitats no obligades i que no dipositen voluntàriament), el pes es redistribueix proporcionalment entre els components actius, sense penalitzar l'entitat.

### 1. Volum

**Què mesura:** la posició relativa (percentil) de l'entitat pels seus fons públics totals (subvencions sense crèdits ICF + contractes + transferències i aportacions de capital del pressupost + acció concertada), comparada amb totes les entitats elegibles: no anonimitzades, amb almenys una subvenció o un contracte i almenys 25.000 EUR de fons públics.

**Per què existeix:** el volum total de fons públics és la mètrica més directa per mesurar la magnitud de recursos públics canalitzats cap a una entitat.

### 2. Freqüència

**Què mesura:** la intensitat de la relació amb el sector públic, mesurada com el nombre de transaccions (subvencions + contractes) per any, expressada com a percentil. El període va del primer al darrer any amb subvenció: el codi també tindria en compte els anys dels contractes, però cap pas del procés no omple aquests camps (vegeu el [diccionari](DICCIONARI.md#camps-sense-migració)), de manera que una entitat que només té contractes no rep aquest component.

**Per què existeix:** una entitat que rep desenes o centenars de transaccions públiques cada any manté una relació estructural amb l'administració, no puntual. La distribució va de menys d'1 transacció/any fins a 500+/any.

**Llindar de robustesa:** el component només s'aplica a entitats amb almenys 100.000 EUR en fons públics totals. Per sota d'aquest llindar, una entitat amb moltes micro-transaccions (quotes d'associat, inscripcions a esdeveniments) podria sortir artificialment alta sense que això reflecteixi cap relació estructural significativa.

### 3. Dominància

**Què mesura:** la posició relativa de l'entitat dins la seva categoria temàtica principal, com de gran és comparada amb les altres entitats que operen en el mateix àmbit.

**Per què existeix:** dues entitats amb el mateix volum total poden tenir situacions molt diferents: una pot ser una de moltes en un àmbit ampli, mentre l'altra pot ser la principal receptora en un àmbit reduït. La dominància combina subvencions (percentil dins la seva finalitat RAISC principal) i contractes (percentil dins el seu grup CPV principal, els 3 primers dígits), ponderats pel pes de les subvencions i dels contractes sobre els fons públics totals. Si l'entitat rep també transferències o acció concertada, els dos pesos sumen menys d'1 i la dominància queda proporcionalment més baixa.

**Llindar de robustesa:** la dominància només es calcula quan l'import de l'entitat en la seva categoria principal (finalitat de subvenció o CPV de contracte) és d'almenys 100.000 EUR i el grup té almenys 10 entitats elegibles. Per sota d'aquest llindar, els percentils dins el grup són poc informatius (una entitat amb 25.000 EUR en una categoria on la mediana és 1.000 EUR pot quedar al p79 sense que això reflecteixi cap dominància real). Quan la categoria principal no arriba al llindar, el component es treu del càlcul i la resta de components es redistribueixen.

### 4. Concurrència (opcional)

**Què mesura:** el percentatge d'import contractual adjudicat sense competència de mercat, contracte menor per sobre del llindar legal, adjudicació directa, negociat sense publicitat, o procediment obert amb un sol licitador.

**Com es calcula:** cada contracte es classifica en tres nivells: *competitiu* (procediment obert, obert simplificat, restringit, diàleg competitiu, concurs de projectes o sistema dinàmic d'adquisició amb 2+ licitadors), *no competitiu* (contracte menor per sobre del llindar legal, adjudicacions directes no menors, negociat sense publicitat, licitació amb negociació, o qualsevol dels procediments oberts anteriors amb un sol licitador), o *desconegut* (sense dades suficients, o contracte menor sota el llindar legal de la LCSP). El percentatge es calcula sobre l'**import**. El score és directament el percentatge d'import no competitiu sobre el total classificable. Un 89% significa que el 89% del volum contractual s'ha adjudicat sense competència.

**Per què s'exclou el contracte menor legal:** l'article 118 de la *LCSP 9/2017* permet adjudicar sense licitació els contractes menors d'obres <40.000 EUR i els de serveis o subministraments <15.000 EUR. Penalitzar entitats per fer servir un procediment legal seria un fals positiu sistemàtic (especialment per associacions o entitats petites que reben sobretot quotes, inscripcions, o despeses recurrents). Aquests contractes es marquen com *menor legal* i queden exclosos del càlcul, igual que els de classificació desconeguda. Els contractes menors per sobre del llindar legal sí es comptabilitzen com no competitius.

**Referents internacionals:** la classificació s'alinea amb l'*EC Single Market Scoreboard* de la Comissió Europea (que marca com a "vermell" entitats amb >20% d'adjudicacions amb sol licitador o >10% d'adjudicacions directes) i amb les *Red Flags in Public Procurement* de l'Open Contracting Partnership.

**Per què no aplica a totes les entitats:** s'activa quan l'entitat acumula almenys 25.000 EUR en contractes públics *classificables* (un cop excloses les adjudicacions menors sota llindar legal). La cobertura de dades de nombre de licitadors és del 25% global (98% des de 2023). Els contractes de procediment obert sense dades de licitadors es classifiquen com a desconeguts i s'exclouen del càlcul, sigui quin sigui l'any.

**Component de fragmentació:** per a entitats amb almenys 5 contractes a la franja 14.900–15.000 € i un indicador de fragmentació d'almenys el 5%, el càlcul combina un 70% de competència i un 30% de fragmentació, on la fragmentació val 500 × (contractes a la franja / contractes totals), amb un màxim de 100. La detecció del patró a la xarxa requereix 3 o més contractes a la franja 14.900–15.000 €; és un criteri separat i no activa per si sola aquest pes.

### 5. Transparència comptable (opcional)

**Què mesura:** el dipòsit de comptes anuals al Registre d'Entitats Jurídiques de Catalunya (REJC). Es valora si l'entitat diposita comptes, amb quina regularitat i si els dipòsits estan actualitzats.

**Base legal:** l'Art. 322-15 del Codi Civil de Catalunya (Llei 4/2008) obliga les associacions declarades d'utilitat pública a dipositar comptes al REJC. Les fundacions tenen obligació equivalent via el Protectorat. La Llei 19/2014 de transparència (Art. 3.4) exigeix obligacions de publicació web per a entitats que rebin >100.000 EUR/any en subvencions, però aquesta és una obligació diferent del dipòsit al REJC.

**Model híbrid:** es penalitzen les entitats legalment obligades que no dipositen comptes (associacions d'utilitat pública i fundacions), i es recompensa les que ho fan voluntàriament. Les entitats sense obligació de dipòsit al REJC (cooperatives, consorcis, entitats religioses, empreses) no reben puntuació de transparència, el seu *score* es calcula amb la resta de components amb dades.

**5 senyals de transparència:**

- **Dipòsit de comptes** (35%): l'entitat té algun dipòsit al REJC
- **Actualitat** (20%): 100 si el darrer dipòsit és com a màxim 2 anys anterior a l'última subvenció, 50 si en són 3, 0 si més
- **Cobertura temporal** (25%): proporció d'anys amb comptes dipositats entre el primer i el darrer any amb subvenció, comptant des del 2014 (el REJC no té dades anteriors)
- **Registre oficial** (15%): l'entitat consta al REJC
- **Compliment ens locals** (5%, opcional): per a ens locals, compliment d'obligacions de tramesa d'informació economicofinancera

El component és **100 menys** la mitjana ponderada dels senyals (un valor alt indica menys transparència, com la resta de components); el pes del senyal d'ens locals es redistribueix quan no aplica. Puntuen les entitats obligades (associacions d'utilitat pública i fundacions, segons el Registre d'Entitats) i les de CIF G que dipositen comptes sense estar-hi obligades; la resta queden sense component.

Font de dades: datasets *Comptes de les entitats jurídiques del Registre d'entitats de Catalunya* (tjhe-8syr), *Registre d'Entitats de Catalunya* (y6fz-g3ff) i *Compliment d'obligacions dels ens locals* (7fnj-etev) del Portal de Transparència de Catalunya.

## Categories de score

| Categoria | Score |
|---|---|
| Baix | 0-25 |
| Moderat | 26-50 |
| Alt | 51-75 |
| Molt alt | 76-100 |

## Administracions com a beneficiàries

El registre de subvencions (RAISC) inclou transferències entre administracions públiques. Per exemple, l'Estat transfereix fons a les comunitats autònomes, diputacions i ajuntaments. Això fa que la Generalitat de Catalunya aparegui com una de les principals receptores de subvencions, ja que rep fons estatals que després redistribueix al territori català.

Això no és una anomalia sinó el funcionament normal del sistema de fons públics autonòmic. Per facilitar l'anàlisi, hem afegit la pestanya "Administracions" a la pàgina de subvencions, que permet filtrar i comparar exclusivament entitats públiques.

## Sobre les dates

El camp "Data concessió" que es mostra a les fitxes d'entitat correspon a la **data de concessió oficial** de la subvenció, és a dir, quan l'òrgan competent va aprovar formalment l'atorgament.

Aquesta data **no és la data de pagament** (quan els fons es van transferir efectivament) ni la **data de justificació** (quan l'entitat va demostrar l'ús correcte dels fons). El procés complet sol seguir l'ordre: concessió → pagament → justificació, amb mesos o fins i tot anys de diferència entre cada fase.

## Limitacions del score

L'algorisme de *score* aplica els mateixos criteris a totes les entitats independentment de la seva mida o tipologia. Això vol dir que un ajuntament gran i una associació petita es comparen amb el mateix barem.

Recomanem comparar entitats dins de la mateixa categoria per obtenir una visió més significativa. Utilitzeu les pestanyes de filtratge ("Administracions", "Tercer Sector", "Fundacions", etc.) a la pàgina de subvencions per comparar entitats de naturalesa similar.

Un *score* alt no implica cap irregularitat. Simplement indica que l'entitat presenta patrons estadístics (volum, freqüència o dominància) que la situen per sobre de la mitjana en un o més indicadors.

Nota: L'algorisme de *score* descrit en aquesta secció s'aplica exclusivament a entitats jurídiques receptores de fons públics. Les fitxes de persones mostren trajectòria registrada i dades documentades, sense una puntuació personal basada en la durada dels càrrecs.

## Anàlisi d'organismes atorgants

A banda del *score* que mesura el comportament de les entitats **receptores** de fons públics, Menjòmetre analitza el comportament dels organismes **atorgants**: departaments, diputacions, ajuntaments i consorcis que convoquen subvencions i adjudiquen contractes. Cada organisme es valora des de dues perspectives complementàries.

**Com distribueix fons:** qualitat distributiva de les subvencions atorgades, quin % s'adjudica per convocatòria competitiva, grau de concentració en pocs beneficiaris, recurrència dels mateixos beneficiaris any rere any. Semàfor: **AIReF Spending Review**.

**Com compra:** qualitat competitiva de la contractació pública, quin % dels contractes s'adjudica sense concurrència (contracte menor, adjudicació directa, sol licitador). Semàfor: **EC Single Market Scoreboard**.

Quan un organisme mostra baixa concurrència en *ambdues* dimensions simultàniament, parlem de **patró creuat**: distribueix subvencions amb baixa competitivitat *i* compra sense concurrència. Aquesta combinació és infreqüent però estadísticament rellevant.

Aquest repositori calcula la primera perspectiva (el semàfor de distribució, vista `grant_organ_mv`). El semàfor de contractació i el patró creuat els calcula una altra part del portal.

### Semàfor de distribució: AIReF Spending Review

Els llindars del semàfor de distribució provenen de l'**AIReF Spending Review Fase I (2019)**, l'estudi d'avaluació de la despesa pública espanyola encarregat pel Ministeri d'Hisenda. L'AIReF (Autoritat Independent de Responsabilitat Fiscal) va analitzar el sistema de subvencions de totes les comunitats autònomes, incloent-hi Catalunya, i va identificar els patrons distributius que indiquen alta concurrència versus distribució concentrada en pocs beneficiaris.

El marc conceptual s'alinea amb l'**OECD Fiscal Federalism Network** i els principis de la **Comissió Europea (OLAF)** sobre gestió transparent de subvencions públiques.

#### Tier A vs. Tier B

**Tier A.** Organismes **discrecionals**: convoquen subvencions per lliure decisió administrativa (concursos, beques, ajuts). El % de convocatòria competitiva és la mètrica principal. *S'hi aplica el semàfor AIReF.*

**Tier B ★.** Organismes **estatutaris**: distribueixen drets econòmics per mandat legal (LAPAD, dependència, RGC, renda garantida, PNC, pensions no contributives). No convoquen: *reconeixen* un dret. El % competitiu no és aplicable. *No s'aplica el semàfor AIReF.*

La classificació Tier B s'aplica quan el 60% o més de les **concessions** de l'organisme (per nombre, no per import) tenen un títol de convocatòria que parla de prestacions (conté "prestaci"). El Dept. de Drets Socials i Inclusió és el cas paradigmàtic.

Només s'analitzen els organismes amb almenys 10 concessions i 100.000 EUR.

#### Llindars del semàfor (Tier A)

**Alta concurrència**: convocatòria competitiva ≥60%.

**Concurrència mitjana**: convocatòria competitiva entre el 30% i el 60%.

**Baixa concurrència**: convocatòria competitiva <30%.

El semàfor depèn només del percentatge de convocatòria competitiva: la recurrència de beneficiaris i el CR10 no es calculen encara (valen NULL). El llindar del 60% és una recomanació de política pública de l'AIReF, no un estàndard estadístic. El semàfor mostra sempre el percentatge exacte, la classificació és orientativa, no un judici sobre la legalitat de les subvencions.

#### Definicions de les mètriques

**% Convocatòria competitiva:** percentatge de les **concessions** (per nombre) el títol de convocatòria de les quals indica una convocatòria pública amb resolució (conté "convoca", "resolució", "beca", "borsa" o "ajut"), sobre les concessions classificades com a competitives o com a altres discrecionals. Les concessions sense títol de convocatòria i les de prestacions no entren al denominador.

**Recurrència (beneficiaris 3+ anys)** i **CR10 (concentració top-10):** definides per la metodologia del portal, però encara no calculades (la vista les deixa a NULL).

Fonts: AIReF *Spending Review de Subvenciones* (2019) · OECD *Fiscal Federalism Network: Grants and Transfers* (2020) · European Court of Auditors, Special Report 10/2015 *Efforts to address problems with public procurement*.

### Semàfor de contractació: EC Single Market Scoreboard

> **No ho calcula aquest repositori.** Aquesta secció descriu una altra part del portal; es manté perquè el text de la metodologia sigui complet.

El semàfor de contractació pública utilitza els llindars de l'**EC Single Market Scoreboard** de la Comissió Europea, que monitora anualment la qualitat competitiva de la contractació pública dels estats membres a partir de dades SIMAP/TED. La metodologia s'alinea amb les **Red Flags in Public Procurement** de l'Open Contracting Partnership (OCP).

#### Llindars del semàfor EC (per organisme atorgant)

**Alta concurrència**: adjudicació directa <10% *i* sol licitador <10% de l'import total.

**Concurrència mitjana**: adjudicació directa 10–20% *o* sol licitador 10–20%.

**Baixa concurrència**: adjudicació directa >20% *o* sol licitador >20%.

L'adjudicació directa inclou contracte menor (LCSP art. 118), negociat sense publicitat i procediment obert amb un sol licitador. Els contractes menors de serveis i subministraments de menys de 15.000 EUR i els d'obres de menys de 40.000 EUR (LCSP art. 118) són legalment exempts de licitació, el semàfor els compta però la interpretació ha de tenir en compte el context del sector.

Fonts: EC *Single Market Scoreboard: Public Procurement* (annual) · Open Contracting Partnership *Red Flags in Public Procurement* (2020) · LCSP Llei 9/2017, de 8 de novembre, de Contractes del Sector Públic.

### Patró creuat (doble senyal)

> **No ho calcula aquest repositori.** Aquesta secció descriu una altra part del portal; es manté perquè el text de la metodologia sigui complet.

Quan un organisme presenta baixa concurrència *simultàniament* en la dimensió de distribució (subvencions) i en la de contractació (compres), parlem de **patró creuat** o doble senyal. Es tracta d'un patró estadísticament infreqüent: la majoria d'organismes presenten concurrència mitjana en contractació però alhora alta concurrència AIReF en distribució.

El patró creuat no implica cap irregularitat, és un indicador estadístic que assenyala organismes on la concurrència competitiva és limitada en ambdues dimensions de despesa. Pot ser conseqüència de la naturalesa del sector (sectors on la competència és estructuralment limitada), de factors institucionals, o de patrons que mereixerien anàlisi addicional.

#### Precedent a la literatura

L'European Court of Auditors (Special Report 10/2015) va identificar empíricament que "organismes que mostren irregularitats en contractació tendeixen a mostrar-ne en distribució de fons". L'OCDE (*Recommendation on Public Integrity*, 2017) promou una visió integral de l'organisme públic, analitzant compres i transferències de forma conjunta. El World Bank PEFA Framework mesura separadament compres i transferències però calcula un índex agregat d'integritat de la despesa.

El càlcul del patró creuat és original de Menjòmetre (2026) i no és un estàndard internacional establert, s'inspira en els marcs de la literatura (ECA, OECD, PEFA) però la seva implementació concreta és pròpia.

## Equivalències orientatives

> **No ho calcula aquest repositori.** Aquesta secció descriu una altra part del portal; es manté perquè el text de la metodologia sigui complet.

Les equivalències tradueixen un import en referents neutrals i comparables. No expressen judicis sobre si la despesa és adequada o excessiva: són punts d'ancoratge per donar escala a la xifra. Seguim un marc **sensible a l'escala**: els denominadors canvien segons la magnitud perquè un mateix referent (pressupost de la Generalitat, PIB) genera percentatges il·legibles per imports petits i ocultaria ordres de magnitud per imports grans.

### Cinc bandes segons l'import anual

- **< 10K €/any i 10K–100K €/any:** múltiple del salari brut mitjà català (IDESCAT), desagregació mensual i, si hi ha més d'un any, període actiu. Ancoratge personal tangible.
- **100K–1M €/any:** percentatge sobre el pressupost mitjà d'un municipi petit, equivalent mensual i múltiple de salaris mitjans com a referent secundari.
- **1M–10M €/any:** euros per habitant de Catalunya (INE), múltiple del pressupost d'un municipi petit típic i desagregació temporal si l'activitat és plurianual.
- **10M–100M €/any:** dies de despesa total de la Generalitat, euros per habitant i percentatge sobre el pressupost consolidat (terciari).
- **> 100M €/any:** percentatge sobre el pressupost de la Generalitat, dies de despesa equivalents, euros per habitant i desagregació anual.

### Valors de referència (font, any)

- **Salari brut mitjà català:** 29.978,69 EUR (2023). [IDESCAT, Retribució anual mitjana](https://www.idescat.cat/indicadors/?id=anuals&n=10361)
- **Població de Catalunya:** 8,01 M habitants (2024). [INE, Xifres oficials de població](https://www.ine.es/dynt3/inebase/es/index.htm?padre=525)
- **Pressupost consolidat Generalitat:** 47.500 M EUR (2025), 46.300 M EUR (2024). [Departament d'Economia, Pressupostos](https://aplicacions.economia.gencat.cat/wpres/)
- **Mediana de pressupost d'ajuntaments < 10.000 habitants:** ≈ 3,8 M EUR (2022). Sindicatura de Comptes, informes municipals.

Les equivalències són **deterministes**: donat un import, una durada i un any de referència, el conjunt retornat és sempre el mateix. Cada element duu la seva font.

## Pressupostos i eficiència: "Què compra cada euro?"

> **No ho calcula aquest repositori.** Aquesta secció descriu una altra part del portal; es manté perquè el text de la metodologia sigui complet.

Tota persona hauria de poder saber com es gasten els seus impostos i si el servei que rep millora amb el temps. La secció **"Què compra cada euro?"** de la pàgina de pressupostos compara l'evolució del cost real de cada departament amb els indicadors de servei que la pròpia Generalitat publica.

### Què mesurem

Comparem l'evolució del cost real de cada departament de la Generalitat, descomptant la inflació, amb indicadors de qualitat del servei que la pròpia Generalitat publica al [Portal de dades obertes de Catalunya](https://analisi.transparenciacatalunya.cat). L'objectiu és respondre una pregunta senzilla: cada euro públic compra més servei o menys servei que fa uns anys?

Per exemple, si el pressupost de Salut ha crescut un 24% en termes reals però la llista d'espera quirúrgica no ha millorat proporcionalment, l'anàlisi reflectirà que cada euro "compra" menys servei sanitari que abans.

Aquesta anàlisi **no determina la causa** de les diferències. Les causes poden incloure canvis en el model de gestió, inflació sectorial, variacions demogràfiques, externalització de serveis, o ineficiències. L'anàlisi exposa la dada, no la interpretació.

### Com ho calculem

Per a cada departament, prenem un o dos indicadors de servei i comparem el valor de l'any base amb el de l'últim any disponible. Quan l'indicador és de tipus "com més, millor" (per exemple, persones assegurades a CatSalut), la comparació és directa. Quan és de tipus "com menys, millor" (per exemple, dies d'espera per a cirurgia), s'inverteix.

Quan un departament té més d'un indicador, els combinem amb una **mitjana geomètrica**, el mateix mètode que les Nacions Unides utilitzen per calcular l'Índex de Desenvolupament Humà (IDH) i que l'OCDE recomana al seu *Handbook on Constructing Composite Indicators* (2008). La mitjana geomètrica evita que un indicador molt bo amagui un altre que va malament: per obtenir un bon resultat, tots els indicadors han de millorar.

Per comparar despesa entre anys diferents sense que la inflació distorsioni els resultats, deflactem els pressupostos amb l'IPC de Catalunya publicat per l'[INE](https://www.ine.es/jaxiT3/Tabla.htm?t=50913). Això converteix els euros de cada any en "euros constants", el poder adquisitiu real descomptant l'encariment general de preus.

### Fonts de dades

**Salut:** Població assegurada CatSalut (dataset `ftq4-h9vk`) + Dies mitjans d'espera per a cirurgia electiva (CatSalut, XML mensual).

**Interior:** Fets penals resolts i taxa de resolució (dataset `qnyt-emjc`).

**CCMA (TV3):** Quota de pantalla d'audiència (Idescat / Kantar Media).

**Drets Socials:** Persones ateses als Serveis Socials Bàsics (dataset `fvnd-jbxf`) + Beneficiaris de prestacions de dependència (dataset `fp8n-2tg5`).

**Cost per departament:** Execució pressupostària de la Generalitat (dataset `ajns-4mi7`).

**Deflactor:** IPC Catalunya (INE, sèrie `IPC251852`).

### Limitacions

- **Indicadors parcials:** Utilitzem només un o dos indicadors per departament. No pretenen ser una avaluació completa de tota l'activitat del departament, sinó una mostra representativa del servei més visible.
- **Anys base diferents:** Cada departament té el seu propi any base segons la disponibilitat de dades. Això vol dir que els resultats de departaments diferents no són directament comparables entre si.
- **IPC general vs. sectorial:** Utilitzem l'IPC general de Catalunya com a deflactor. Hem verificat que la diferència amb l'IPC sectorial sanitari no és significativa en el període analitzat (font: INE, sèries IPC per grups ECOICOP), però és una aproximació.
- **Causes múltiples:** L'anàlisi no determina per què un departament "compra" més o menys servei. Les causes poden incloure canvis en el model de gestió, inflació sectorial, variacions demogràfiques, externalització de serveis, o ineficiències reals.

### Referències

- OECD/JRC (2008). *Handbook on Constructing Composite Indicators: Methodology and User Guide.* ISBN 978-92-64-04345-9.
- UNDP. *Human Development Report: Technical Notes* (metodologia de l'Índex de Desenvolupament Humà).
- INE: IPC Catalunya: [ine.es/jaxiT3/Tabla.htm?t=50913](https://www.ine.es/jaxiT3/Tabla.htm?t=50913)
- Portal de Dades Obertes de Catalunya: [analisi.transparenciacatalunya.cat](https://analisi.transparenciacatalunya.cat)

## Disclaimers

L'objectiu del Menjòmetre Score és ajudar ciutadans i periodistes a identificar patrons estadístics que mereixen atenció pública. La majoria de subvencions són legítimes i necessàries. Un *score* alt identifica patrons estadístics de volum, freqüència o dominància, no irregularitat.

El codi que calcula el *score* i les xifres de subvencions, contractes i organismes atorgants és obert (AGPL-3.0-or-later): és aquest repositori. Les dades vénen de les fonts oficials (RAISC i Dades Obertes de Catalunya, Sindicatura de Comptes). El procés no en canvia cap import: fusiona duplicats d'una mateixa entitat, descarta còpies i anul·lacions de contractes i agrupa els beneficiaris no publicables, tal com descriu aquest document.

> Els drets d'accés, rectificació i supressió, i com exercir-los, són a [l'avís legal, secció 8](https://catalunya.ai/avis-legal#drets).
