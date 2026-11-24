/**
 * Menjometre RAISC Data Sync Script
 *
 * Imports RAISC (Registre d'Ajuts i Subvencions de Catalunya) from the
 * public SODA API (s9xt-n979) into your PostgreSQL database (DATABASE_URL).
 *
 * ~19.5M records with CIF, geographic data, purpose hierarchy, and admin level.
 *
 * Usage:
 *   npx tsx src/connectors/sync-raisc.ts --full [--skip-aggregation]
 *   npx tsx src/connectors/sync-raisc.ts --updated-since=YYYY-MM-DD
 *   npx tsx src/connectors/sync-raisc.ts --resume [--skip-aggregation]
 *   npx tsx src/connectors/sync-raisc.ts --dry-run
 */

import { createPool } from "../lib/db";
import {
  type RaiscRow,
  mapToEntity,
  mapToGrant,
  loadTerritorialMapping,
  upsertEntitiesBatch,
  insertGrantsBatch,
} from "../lib/raisc-helpers";
import { buildUpdatedSinceWhere, fetchRaiscBatch, fetchRaiscCount } from "../lib/soda/raisc-client";

const db = createPool();

// ============================================================
// Constants
// ============================================================

const SODA_BATCH_SIZE = 50_000;
const DB_BATCH_SIZE = 10_000;

// ============================================================
// Sync log
// ============================================================

async function createSyncLog(notes?: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO data_sync_log (status, data_source, error_message, notes)
     VALUES ('running', 'raisc_concessions', 'source:soda', $1)
     RETURNING id`,
    [notes ?? null]
  );
  return rows[0].id;
}

async function updateSyncLog(
  id: string,
  updates: {
    records_fetched?: number;
    records_processed?: number;
    records_skipped?: number;
    last_offset?: number;
    status?: string;
    error_message?: string;
    completed_at?: string;
    notes?: string;
  }
) {
  const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  // Column names come from the typed keys above, never from input.
  const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(", ");
  await db.query(`UPDATE data_sync_log SET ${sets} WHERE id = $1`, [id, ...entries.map(([, v]) => v)]);
}

async function getLastOffset(): Promise<number> {
  const { rows } = await db.query<{ last_offset: number | null }>(
    `SELECT last_offset FROM data_sync_log
     WHERE data_source = 'raisc_concessions'
       AND error_message LIKE 'source:soda%'
       AND status = 'completed'
     ORDER BY completed_at DESC NULLS LAST
     LIMIT 1`
  );
  return rows[0]?.last_offset || 0;
}

// ============================================================
// Main sync
// ============================================================

async function main() {
  // Offset resume is unsafe for RAISC because Socrata :id values are strings
  // and new rows interleave across the full ordered dataset. An :updated_at
  // window is safe for incremental mode because the filtered set is rebuilt by
  // SODA on every request and we always walk that filtered set from offset 0.
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isResume = args.includes("--resume");
  const skipAggregation = args.includes("--skip-aggregation");
  const updatedSince = args.find((arg) => arg.startsWith("--updated-since="))?.split("=").slice(1).join("=");

  if (isResume && updatedSince) {
    console.error(
      "ERROR: --updated-since and --resume are mutually exclusive: " +
        "RAISC offset resume skips interleaved Socrata :id rows."
    );
    process.exit(1);
  }

  const where = updatedSince ? buildUpdatedSinceWhere(updatedSince) : undefined;

  console.log("=== Menjometre RAISC Data Sync (SODA API) ===");
  console.log(`Source: analisi.transparenciacatalunya.cat/resource/s9xt-n979`);
  console.log(`Mode: ${isDryRun ? "dry-run" : isResume ? "resume" : updatedSince ? "updated-since" : "full"}`);
  if (updatedSince) console.log(`Window: :updated_at > ${updatedSince}T00:00:00`);

  // Get total count
  const totalRecords = await fetchRaiscCount(where);
  console.log(`Total SODA records: ${totalRecords.toLocaleString()}\n`);

  await loadTerritorialMapping(db);

  let startOffset = 0;
  if (isResume) {
    startOffset = await getLastOffset();
    if (startOffset > 0) {
      console.log(`Resuming from offset ${startOffset.toLocaleString()}`);
    }
  }

  const syncId = isDryRun ? null : await createSyncLog(updatedSince ? `updated_since=${updatedSince}` : undefined);

  let totalRead = 0;
  let totalProcessed = 0;
  let totalSkipped = 0;
  let offset = startOffset;

  while (true) {
    // Fetch batch from SODA
    const records = await fetchRaiscBatch(offset, SODA_BATCH_SIZE, where);
    if (!records || records.length === 0) break;

    totalRead += records.length;

    if (isDryRun && totalRead > 10) {
      console.log("\nDry run: showing first 3 records:");
      for (const r of records.slice(0, 3)) {
        console.log(`  clau=${r.clau} dept=${r.departament_o_entitat_local_d_adscripci_} cif=${r.cif_beneficiari} amount=${r.import_subvenci_pr_stec_ajut}`);
      }
      break;
    }

    // Process in DB-sized sub-batches
    for (let i = 0; i < records.length; i += DB_BATCH_SIZE) {
      const subBatch = records.slice(i, i + DB_BATCH_SIZE);

      // Map to entities and grants
      const entityMap = new Map<string, ReturnType<typeof mapToEntity>>();
      const grants: NonNullable<ReturnType<typeof mapToGrant>>[] = [];

      // Two maps: CIF→entity (authoritative) and slug→CIF (cross-ref)
      const cifToEntity = new Map<string, ReturnType<typeof mapToEntity>>();
      const slugToCif = new Map<string, string>();

      for (const record of subBatch) {
        const row = record as unknown as RaiscRow;
        const entity = mapToEntity(row);

        if (entity.cif) {
          // CIF-first: CIF is the authoritative identity
          const existing = cifToEntity.get(entity.cif);
          if (!existing) {
            cifToEntity.set(entity.cif, entity);
            slugToCif.set(entity.slug, entity.cif);
          } else {
            // Enrich existing CIF entity with missing data
            if (entity.comarca && !existing.comarca) {
              existing.comarca = entity.comarca;
              existing.comarca_code = entity.comarca_code;
              existing.province_code = entity.province_code;
            }
          }
        } else {
          // No CIF: only add if slug isn't already claimed by a CIF entity
          const claimedCif = slugToCif.get(entity.slug);
          if (claimedCif) {
            // Slug already belongs to a CIF entity — enrich it instead
            const cifEntity = cifToEntity.get(claimedCif)!;
            if (entity.comarca && !cifEntity.comarca) {
              cifEntity.comarca = entity.comarca;
              cifEntity.comarca_code = entity.comarca_code;
              cifEntity.province_code = entity.province_code;
            }
          } else if (!entityMap.has(entity.slug)) {
            entityMap.set(entity.slug, entity);
          }
        }
      }

      // Merge CIF entities into entityMap (CIF key, not slug key)
      cifToEntity.forEach((entity, cif) => {
        entityMap.set(cif, entity);
        // Remove any no-CIF entity with same slug (CIF wins)
        if (entityMap.has(entity.slug) && entityMap.get(entity.slug) !== entity) {
          entityMap.delete(entity.slug);
        }
      });

      for (const record of subBatch) {
        const row = record as unknown as RaiscRow;
        const entity = mapToEntity(row);

        // Resolve canonical slug: CIF-first, then slug
        const entityKey = entity.cif
          ? entity.cif
          : (slugToCif.get(entity.slug) || entity.slug);
        const canonicalSlug = entityMap.get(entityKey)?.slug || entity.slug;
        const grant = mapToGrant(row, canonicalSlug);
        if (grant) {
          grants.push(grant);
        } else {
          totalSkipped++;
        }
      }

      // Upsert entities, then grants
      await upsertEntitiesBatch(db, entityMap);
      const { processed, skipped } = await insertGrantsBatch(db, grants);
      totalProcessed += processed;
      totalSkipped += skipped;
    }

    offset += records.length;

    console.log(
      `  Offset ${offset.toLocaleString()}/${totalRecords.toLocaleString()} | processed: ${totalProcessed.toLocaleString()} | skipped: ${totalSkipped.toLocaleString()}`
    );

    // Checkpoint
    if (syncId) {
      await updateSyncLog(syncId, {
        records_fetched: totalRead,
        records_processed: totalProcessed,
        records_skipped: totalSkipped,
        last_offset: offset,
      });
    }

    if (records.length < SODA_BATCH_SIZE) break;
  }

  // Complete
  if (syncId) {
    await updateSyncLog(syncId, {
      status: "completed",
      completed_at: new Date().toISOString(),
      records_fetched: totalRead,
      records_processed: totalProcessed,
      records_skipped: totalSkipped,
      last_offset: offset,
    });
  }

  console.log("\n=== Summary ===");
  console.log(`Read: ${totalRead.toLocaleString()}`);
  console.log(`Processed: ${totalProcessed.toLocaleString()}`);
  console.log(`Skipped: ${totalSkipped.toLocaleString()}`);

  if (!isDryRun && !skipAggregation) {
    console.log("\nNote: Run 'npx tsx src/pipeline/aggregate-stats.ts' to update entity totals.");
  }

  console.log("\nDone.");
  await db.end();
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  // Mark the sync as failed so the row is not left as 'running'.
  try {
    await db.query(
      `UPDATE data_sync_log SET status = 'failed', completed_at = NOW(), error_message = $1
       WHERE id = (
         SELECT id FROM data_sync_log
         WHERE data_source = 'raisc_concessions' AND status = 'running'
         ORDER BY started_at DESC LIMIT 1
       )`,
      [String((err as Error).message ?? err).substring(0, 500)]
    );
  } catch {}
  await db.end().catch(() => {});
  process.exit(1);
});
