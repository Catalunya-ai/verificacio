/**
 * Seed territorial mapping table with Catalan comarca/province data.
 *
 * Maps codi_territorial (format "comarca_province") to comarca/province names.
 * 42 comarques + 4 provinces (Barcelona, Girona, Lleida, Tarragona).
 *
 * Usage: npx tsx src/connectors/seed-territorial-mapping.ts
 */

import { createPool } from "../lib/db";

const db = createPool(1);

// Official Catalan comarques (ID → name)
const COMARQUES: Record<number, string> = {
  1: "Alt Camp",
  2: "Alt Empordà",
  3: "Alt Penedès",
  4: "Alt Urgell",
  5: "Alta Ribagorça",
  6: "Anoia",
  7: "Bages",
  8: "Baix Camp",
  9: "Baix Ebre",
  10: "Baix Empordà",
  11: "Baix Llobregat",
  12: "Baix Penedès",
  13: "Barcelonès",
  14: "Berguedà",
  15: "Cerdanya",
  16: "Conca de Barberà",
  17: "Garraf",
  18: "Garrigues",
  19: "Garrotxa",
  20: "Gironès",
  21: "Maresme",
  22: "Montsià",
  23: "Noguera",
  24: "Osona",
  25: "Pallars Jussà",
  26: "Pallars Sobirà",
  27: "Pla d'Urgell",
  28: "Pla de l'Estany",
  29: "Priorat",
  30: "Ribera d'Ebre",
  31: "Ripollès",
  32: "Segarra",
  33: "Segrià",
  34: "Selva",
  35: "Solsonès",
  36: "Tarragonès",
  37: "Terra Alta",
  38: "Urgell",
  39: "Val d'Aran",
  40: "Vallès Occidental",
  41: "Vallès Oriental",
  42: "Moianès",
};

// Province codes (matching INE codes)
const PROVINCES: Record<string, string> = {
  "08": "Barcelona",
  "17": "Girona",
  "25": "Lleida",
  "43": "Tarragona",
};

// Comarca → province mapping
const COMARCA_PROVINCE: Record<number, string> = {
  1: "43", 2: "17", 3: "08", 4: "25", 5: "25",
  6: "08", 7: "08", 8: "43", 9: "43", 10: "17",
  11: "08", 12: "43", 13: "08", 14: "08", 15: "17",
  16: "43", 17: "08", 18: "25", 19: "17", 20: "17",
  21: "08", 22: "43", 23: "25", 24: "08", 25: "25",
  26: "25", 27: "25", 28: "17", 29: "43", 30: "43",
  31: "17", 32: "25", 33: "25", 34: "17", 35: "25",
  36: "43", 37: "43", 38: "25", 39: "25", 40: "08",
  41: "08", 42: "08",
};

async function main() {
  console.log("=== Seeding Territorial Mapping ===\n");

  const rows: {
    codi_territorial: string;
    comarca_code: string;
    province_code: string;
    comarca_name: string;
    province_name: string;
  }[] = [];

  for (const [comarcaId, comarcaName] of Object.entries(COMARQUES)) {
    const id = Number(comarcaId);
    const provinceCode = COMARCA_PROVINCE[id];
    if (!provinceCode) {
      console.warn(`  No province mapping for comarca ${id} (${comarcaName})`);
      continue;
    }

    const provinceName = PROVINCES[provinceCode];
    const codiTerritorial = `${id}_${provinceCode}`;

    rows.push({
      codi_territorial: codiTerritorial,
      comarca_code: String(id),
      province_code: provinceCode,
      comarca_name: comarcaName,
      province_name: provinceName,
    });
  }

  console.log(`Inserting ${rows.length} territorial mappings...`);

  const params = rows.flatMap((r) => [
    r.codi_territorial, r.comarca_code, r.province_code, r.comarca_name, r.province_name,
  ]);
  const placeholders = rows
    .map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`)
    .join(", ");

  await db.query(
    `INSERT INTO territorial_mapping (codi_territorial, comarca_code, province_code, comarca_name, province_name)
     VALUES ${placeholders}
     ON CONFLICT (codi_territorial) DO UPDATE SET
       comarca_code = EXCLUDED.comarca_code,
       province_code = EXCLUDED.province_code,
       comarca_name = EXCLUDED.comarca_name,
       province_name = EXCLUDED.province_name`,
    params
  );

  console.log(`Done: ${rows.length} mappings seeded.\n`);

  // Verify
  const { rows: check } = await db.query<{ n: string }>("SELECT COUNT(*) AS n FROM territorial_mapping");
  console.log(`Verification: ${check[0].n} rows in territorial_mapping`);
  const { rows: sample } = await db.query(
    "SELECT * FROM territorial_mapping ORDER BY codi_territorial LIMIT 3"
  );
  if (sample.length > 0) {
    console.log("Sample:", sample);
  }
}

main()
  .catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.end());
