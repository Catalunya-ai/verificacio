/**
 * Seed accio_concertada table with data from Sindicatura de Comptes Informe 3/2024
 * Source: https://www.sindicatura.cat/documents/36414/85841/2024_03_ca.pdf
 * Period: 2016-2020
 * Scope: DGAIA spending on child welfare services (Quadre 13)
 *
 * Data in thousands of EUR (converted to EUR on insert)
 *
 * The figures are transcribed from the report's table; the slugs are those the
 * RAISC loader gives the same entities (run sync-raisc.ts first).
 *
 * Usage: npx tsx src/connectors/seed-accio-concertada-sindicatura.ts [--dry-run]
 *   (connection: DATABASE_URL, see src/lib/db.ts)
 */

import { createPool } from "../lib/db";

const db = createPool(1);

const SOURCE_DOCUMENT = "sindicatura_informe_3_2024";
const SOURCE_TABLE = "quadre_13";
const SOURCE_URL = "https://www.sindicatura.cat/documents/36414/85841/2024_03_ca.pdf";
const DEPARTMENT = "DGAIA";

// Entity mapping: Sindicatura name -> Menjometre slug
// Amounts in thousands of EUR per year
interface EntityData {
  sindicatura_name: string;
  slug: string;
  amounts: { [year: number]: number | null }; // thousands EUR
}

const entities: EntityData[] = [
  {
    sindicatura_name: "Fundacio Privada RESILIS",
    slug: "FUNDACIO-PRIVADA-RESILIS",
    amounts: { 2016: 11396, 2017: 13142, 2018: 17835, 2019: 19249, 2020: 18809 },
  },
  {
    sindicatura_name: "Instituto de Trabajo Social y de Servicios Sociales (Intress)",
    slug: "INST-TRABAJO-SOC-Y-DE-SERV-SOCIALES",
    amounts: { 2016: 6051, 2017: 5786, 2018: 10681, 2019: 21585, 2020: 20804 },
  },
  {
    sindicatura_name: "Fundacion Diagrama Intervencion Psicosocial",
    slug: "FUNDACIO-DIAGRAMA",
    amounts: { 2016: null, 2017: null, 2018: 8024, 2019: 27262, 2020: 23439 },
  },
  {
    sindicatura_name: "Suara Serveis SCCL",
    slug: "SUARA-SERVEIS-S-C-C-L",
    amounts: { 2016: 3315, 2017: 4076, 2018: 9488, 2019: 14526, 2020: 15445 },
  },
  {
    sindicatura_name: "Eduvic, SCCL",
    slug: "EDUVIC-SCCL",
    amounts: { 2016: 633, 2017: 697, 2018: 7360, 2019: 20727, 2020: 16852 },
  },
  {
    sindicatura_name: "Fundacio Privada Merce Fontanilles",
    slug: "FUNDACIO-PRIVADA-MERCE-FONTANILLES",
    amounts: { 2016: 6421, 2017: 7062, 2018: 9116, 2019: 8598, 2020: 10184 },
  },
  {
    sindicatura_name: "Actua SCCL",
    slug: "ACTUA-SCCL",
    amounts: { 2016: 3864, 2017: 4165, 2018: 5880, 2019: 6761, 2020: 6679 },
  },
  {
    sindicatura_name: "Fundacio Privada Idea",
    slug: "FUNDACIO-PRIVADA-IDEA",
    amounts: { 2016: 4539, 2017: 4708, 2018: 5030, 2019: 5357, 2020: 5377 },
  },
  {
    sindicatura_name: "Gestio i Disseny, SCCL",
    slug: "GEDI-GESTIO-I-DISSENY-SCCL",
    amounts: { 2016: 2033, 2017: 4968, 2018: 5005, 2019: 6002, 2020: 5995 },
  },
  {
    sindicatura_name: "Associacio Asteroide B-612",
    slug: "ASTEROIDE-B-612",
    amounts: { 2016: 4106, 2017: 4226, 2018: 4030, 2019: 4519, 2020: 4588 },
  },
  {
    sindicatura_name: "Fundacio Accio Social Infancia",
    slug: "FUNDACIO-ACCIO-SOCIAL-INFANCIA",
    amounts: { 2016: 3286, 2017: 3316, 2018: 4481, 2019: 3931, 2020: 4342 },
  },
  {
    sindicatura_name: "Fundacio Privada Eveho",
    slug: "FUNDACIO-PRIVADA-EVEHO",
    amounts: { 2016: 2370, 2017: 2582, 2018: 3117, 2019: 4340, 2020: 5769 },
  },
  {
    sindicatura_name: "UTE Fundacio Merce Fontanilles + Fundacio Resilis (1)",
    slug: "UTE-FP-MERCE-FONTANILLES-DE-MANEJAMENT-DE-SERVEIS-I-D-INICIATIVES-SOCIALS-FP-RESILIS",
    amounts: { 2016: 370, 2017: 1270, 2018: 3906, 2019: 4368, 2020: 4360 },
  },
  {
    sindicatura_name: "Integracio Social de Menors Isom SCCL",
    slug: "INTEGRACIO-SOCIAL-DE-MENORS-ISOM-SCCL",
    amounts: { 2016: null, 2017: 86, 2018: 2042, 2019: 5153, 2020: 6465 },
  },
  {
    sindicatura_name: "Drecera, SCCL",
    slug: "DRECERA-SCCL",
    amounts: { 2016: 2451, 2017: 2450, 2018: 2430, 2019: 2424, 2020: 2507 },
  },
  {
    sindicatura_name: "Casa Sant Josep de Tarragona",
    slug: "FUNDACIO-CASA-SANT-JOSEP-DE-TARRAGONA",
    amounts: { 2016: 2154, 2017: 2083, 2018: 2304, 2019: 2646, 2020: 2837 },
  },
  {
    sindicatura_name: "Fundacio Aldees Infantils SOS de Catalunya",
    slug: "FUNDACIO-ALDEES-INFANTILS-SOS-DE-CATALUNYA",
    amounts: { 2016: 2437, 2017: 2439, 2018: 2007, 2019: 2194, 2020: 2502 },
  },
  {
    sindicatura_name: "Fundacio Privada Assistencial Sanitaria i Social",
    slug: "FUNDACIO-PRIVADA-ASSISTENCIAL-SANITARIA-I-SOCIAL",
    amounts: { 2016: 2300, 2017: 2238, 2018: 2288, 2019: 2370, 2020: 2351 },
  },
  {
    sindicatura_name: "Sant Joan de Deu Terres de Lleida",
    slug: "SANT-JOAN-DE-DEU-TERRES-DE-LLEIDA",
    amounts: { 2016: null, 2017: null, 2018: 1445, 2019: 4863, 2020: 5146 },
  },
  {
    sindicatura_name: "UTE Fundacio Merce Fontanilles + Fundacio Resilis (2)",
    slug: "UTE-FUNDACIO-MERCE-FONTANILLES-FUNDACIO",
    amounts: { 2016: null, 2017: null, 2018: null, 2019: 4647, 2020: 6558 },
  },
  {
    sindicatura_name: "Residencia Assistencial de Manresa",
    slug: "RESIDENCIA-ASSISTENCIAL-DE-MANRESA",
    amounts: { 2016: 2070, 2017: 2079, 2018: 1995, 2019: 2164, 2020: 2183 },
  },
  {
    sindicatura_name: "Associacio per a la Creacio i Estudis de Projectes Socials",
    slug: "ASCEPS-ASSOCCIACIO-PER-A-LA-CREACIO-D-ESTUDIS-I-PROJECTES-SOCIALS",
    amounts: { 2016: 1679, 2017: 1593, 2018: 1670, 2019: 1684, 2020: 1919 },
  },
  {
    sindicatura_name: "Organismo Benefico Asistencial",
    slug: "FUNDACION-ORGANISMO-BENEFICO-ASISTENCIAL-O-B-A",
    amounts: { 2016: 1588, 2017: 1577, 2018: 1582, 2019: 1576, 2020: 1634 },
  },
];

// "Altres 78 entitats" aggregated row
const ALTRES_78: EntityData = {
  sindicatura_name: "Altres 78 entitats (agregat)",
  slug: "_ALTRES_78_ENTITATS_DGAIA",
  amounts: { 2016: 32640, 2017: 33548, 2018: 36807, 2019: 43831, 2020: 42913 },
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`Seeding accio_concertada from Sindicatura Informe 3/2024${dryRun ? " [DRY RUN]" : ""}`);

  // Resolve entity_ids from slugs
  const allSlugs = entities.map((e) => e.slug);
  const { rows: dbEntities } = await db.query<{ id: string; slug: string }>(
    "SELECT id, slug FROM entities WHERE slug = ANY($1::text[])",
    [allSlugs]
  );

  const slugToId = new Map<string, string>();
  for (const e of dbEntities) {
    slugToId.set(e.slug, e.id);
  }

  // Build rows
  interface AccioConcertadaRow {
    entity_id: string | null;
    entity_slug: string;
    entity_name_source: string;
    amount: number;
    year: number;
    department: string;
    source_document: string;
    source_table: string;
    source_url: string;
  }
  const rows: AccioConcertadaRow[] = [];
  let totalEur = 0;
  let matchedCount = 0;
  let unmatchedSlugs: string[] = [];

  for (const entity of [...entities, ALTRES_78]) {
    const entityId = slugToId.get(entity.slug) || null;
    if (entityId) matchedCount++;
    else if (entity.slug !== "_ALTRES_78_ENTITATS_DGAIA") unmatchedSlugs.push(entity.slug);

    for (const [yearStr, thousandsEur] of Object.entries(entity.amounts)) {
      if (thousandsEur === null) continue;
      const year = parseInt(yearStr);
      const amountEur = thousandsEur * 1000; // convert thousands to EUR
      totalEur += amountEur;

      rows.push({
        entity_id: entityId,
        entity_slug: entity.slug,
        entity_name_source: entity.sindicatura_name,
        amount: amountEur,
        year,
        department: DEPARTMENT,
        source_document: SOURCE_DOCUMENT,
        source_table: SOURCE_TABLE,
        source_url: SOURCE_URL,
      });
    }
  }

  console.log(`\nPrepared ${rows.length} rows (${entities.length + 1} entities x 5 years max)`);
  console.log(`Total: ${(totalEur / 1e6).toFixed(1)}M EUR`);
  console.log(`Matched to DB: ${matchedCount}/${entities.length} entities`);
  if (unmatchedSlugs.length > 0) {
    console.log(`\nUnmatched slugs (will insert with entity_id=NULL):`);
    unmatchedSlugs.forEach((s) => console.log(`  - ${s}`));
  }

  if (dryRun) {
    console.log("\n[DRY RUN] No data inserted.");
    // Show sample
    console.log("\nSample rows:");
    rows.slice(0, 3).forEach((r) =>
      console.log(`  ${r.entity_slug} | ${r.year} | ${(r.amount / 1000).toFixed(0)}K EUR | matched=${!!r.entity_id}`)
    );
    return;
  }

  // Upsert rows
  const columns = [
    "entity_id", "entity_slug", "entity_name_source", "amount", "year",
    "department", "source_document", "source_table", "source_url",
  ] as const;
  const params = rows.flatMap((r) => columns.map((c) => r[c]));
  const placeholders = rows
    .map((_, i) => `(${columns.map((__, j) => `$${i * columns.length + j + 1}`).join(", ")})`)
    .join(",\n");

  await db.query(
    `INSERT INTO accio_concertada (${columns.join(", ")})
     VALUES ${placeholders}
     ON CONFLICT (entity_slug, year, source_document, source_table) DO UPDATE SET
       entity_id = EXCLUDED.entity_id,
       entity_name_source = EXCLUDED.entity_name_source,
       amount = EXCLUDED.amount,
       department = EXCLUDED.department,
       source_url = EXCLUDED.source_url,
       updated_at = NOW()`,
    params
  );

  console.log(`\nInserted/updated ${rows.length} rows`);

  // Update entity totals (aggregate-stats.ts recomputes the same column).
  console.log("\nUpdating entity accio_concertada totals...");
  const { rowCount } = await db.query(`
      WITH agg AS (
        SELECT entity_id, SUM(amount) as total
        FROM accio_concertada
        WHERE entity_id IS NOT NULL
        GROUP BY entity_id
      )
      UPDATE entities e
      SET total_accio_concertada = agg.total,
          updated_at = NOW()
      FROM agg
      WHERE e.id = agg.entity_id
  `);
  console.log(`  ${rowCount ?? 0} entities updated`);

  console.log("\nDone! Check with:");
  console.log("  SELECT entity_slug, SUM(amount)::bigint AS total_eur FROM accio_concertada GROUP BY entity_slug ORDER BY total_eur DESC;");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.end());
