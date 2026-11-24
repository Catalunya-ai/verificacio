/**
 * Shared CIF-first entity resolution module.
 *
 * Used by the RAISC loader to ensure entities are looked up by CIF before
 * creating new ones, preventing orphan entities with different slugs for the
 * same real-world entity.
 */

import type { Queryable } from "./db";
import { withRetry } from "./raisc-helpers";

const CIF_CHUNK_SIZE = 300;

export interface ResolvedEntity {
  id: string;
  slug: string;
}

/**
 * Look up existing entities by CIF in batches.
 * Returns a Map<cif, { id, slug }> for all CIFs that have a matching entity.
 *
 * Fails hard on query errors (not silent skip) to prevent orphan creation.
 */
export async function resolveEntitiesByCif(
  cifs: string[],
  db: Queryable
): Promise<Map<string, ResolvedEntity>> {
  const result = new Map<string, ResolvedEntity>();
  if (cifs.length === 0) return result;

  // Deduplicate and filter
  const uniqueCifs = [...new Set(cifs.filter((c) => c != null && c !== ""))];

  for (let i = 0; i < uniqueCifs.length; i += CIF_CHUNK_SIZE) {
    const chunk = uniqueCifs.slice(i, i + CIF_CHUNK_SIZE);

    let rows: { id: string; slug: string; cif: string | null }[];
    try {
      ({ rows } = await withRetry(async () => {
        return await db.query<{ id: string; slug: string; cif: string | null }>(
          "SELECT id, slug, cif FROM entities WHERE cif = ANY($1::text[])",
          [chunk]
        );
      }, undefined, "entity-cif-lookup"));
    } catch (error) {
      throw new Error(`CIF lookup failed (chunk ${i}): ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const row of rows) {
      if (row.cif != null) {
        result.set(row.cif, { id: row.id, slug: row.slug });
      }
    }
  }

  return result;
}

/**
 * For a batch of entities with CIF, remap their slugs to match
 * any existing entity in the DB with the same CIF.
 *
 * This prevents creating new entities when a CIF already exists
 * under a different name variant.
 */
export async function remapSlugsToExistingCifs<
  T extends { slug: string; cif: string | null }
>(entities: T[], db: Queryable): Promise<number> {
  const cifsToCheck = entities
    .map((e) => e.cif)
    .filter((c): c is string => c != null && c !== "");

  if (cifsToCheck.length === 0) return 0;

  const existing = await resolveEntitiesByCif(cifsToCheck, db);

  let remapped = 0;
  for (const e of entities) {
    const cif = e.cif;
    if (cif == null) continue;
    const canonical = existing.get(cif);
    if (canonical !== undefined && canonical.slug !== e.slug) {
      e.slug = canonical.slug;
      remapped++;
    }
  }

  return remapped;
}
