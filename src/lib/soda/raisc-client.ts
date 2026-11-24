/**
 * SODA client for RAISC dataset (s9xt-n979)
 *
 * Catalan grants registry — ~19.5M records with CIF, geography, purpose hierarchy.
 * Public SODA API on analisi.transparenciacatalunya.cat.
 */

const RAISC_SODA_ENDPOINT =
  "https://analisi.transparenciacatalunya.cat/resource/s9xt-n979.json";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2_000;

export interface RaiscSodaRecord {
  clau?: string;
  entitat_oo_aa_o_departament?: string;
  entitat_oo_aa_o_departament_1?: string;
  codi_raisc?: string;
  codi_bdns?: string;
  discriminador_de_la_concessi?: string;
  any_de_la_convocat_ria?: string;
  objecte_de_la_convocat_ria?: string;
  t_tol_convocat_ria_catal?: string;
  t_tol_convocat_ria_castell?: string;
  bases_reguladores_url_catal?: string;
  bases_reguladores_url_castell?: string;
  subfinalitat_codi?: string;
  subfinalitat?: string;
  finalitat_rais_codi?: string;
  finalitat_rais?: string;
  finalitat_p_blica_codi?: string;
  finalitat_p_blica?: string;
  tipus_d_instument_d_ajut?: string;
  tipus_d_instument_d_ajut_1?: string;
  aplicaci_pressupost_ria?: string;
  tipus_de_beneficiaris_codi?: string;
  tipus_de_beneficiaris?: string;
  cif_beneficiari?: string;
  ra_social_del_beneficiari?: string;
  codi_territorial?: string;
  data_concessi?: string;
  import_subvenci_pr_stec_ajut?: string;
  administraci_codi?: string;
  administraci_?: string;
  departament_o_entitat_local_d_adscripci_codi?: string;
  departament_o_entitat_local_d_adscripci_?: string;
  ajut_d_estat?: string;
}

interface SodaQueryOptions {
  select?: string;
  where?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

function buildUrl(options: SodaQueryOptions): string {
  const params = new URLSearchParams();
  if (options.select) params.set("$select", options.select);
  if (options.where) params.set("$where", options.where);
  if (options.order) params.set("$order", options.order);
  if (options.limit) params.set("$limit", String(options.limit));
  if (options.offset !== undefined) params.set("$offset", String(options.offset));
  return `${RAISC_SODA_ENDPOINT}?${params.toString()}`;
}

export async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const appToken = process.env.SODA_APP_TOKEN;
  if (appToken) {
    headers["X-App-Token"] = appToken;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers });

      if (res.ok) return res;

      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(
            `RAISC SODA API returned ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }

      throw new Error(`RAISC SODA API error: ${res.status} ${res.statusText}`);
    } catch (err) {
      if (attempt < retries && (err as Error).message?.includes("fetch")) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`Network error, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }

  throw new Error("RAISC SODA API: max retries exceeded");
}

export async function fetchRaiscBatch(
  offset: number,
  batchSize = 50_000,
  where?: string
): Promise<RaiscSodaRecord[]> {
  const url = buildUrl({
    limit: batchSize,
    offset,
    order: ":id",
    where,
  });

  const res = await fetchWithRetry(url);
  return res.json();
}

export async function fetchRaiscCount(where?: string): Promise<number> {
  const url = buildUrl({
    select: "count(*) as total",
    where,
  });

  const res = await fetchWithRetry(url);
  const data = await res.json();
  return parseInt(data[0]?.total ?? "0", 10);
}

/**
 * SoQL filter for an incremental load: rows the publisher created or changed
 * after the start of `date` (YYYY-MM-DD), using the Socrata system field
 * `:updated_at`. The date is validated so nothing else reaches the query.
 */
export function buildUpdatedSinceWhere(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--updated-since expects a date as YYYY-MM-DD, got ${JSON.stringify(date)}`);
  }
  return `:updated_at > '${date}T00:00:00'`;
}

export { RAISC_SODA_ENDPOINT };
