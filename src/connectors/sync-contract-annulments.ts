/**
 * Official annulments of contracts: load the lines, decide, apply.
 *
 * The open-data source (dataset ybgg-dgi6) lists, besides the awards, the notices the organ later
 * annulled (phase "Anul·lació"). The contracts load stores each of those lines as a contract. This
 * script keeps them from counting as awards:
 *
 *   1. Reads every annulment line (page size 1000, ordered, retries with backoff, pages cached in
 *      a scratch folder outside the repository) and stores it in contract_official_annulments.
 *   2. In ONE transaction: decide_contract_annulments() stores the decisions of rules 1 to 3 (each with
 *      its reason and evidence, by natural key), apply_contract_annulments() applies them, and the
 *      contract totals of the affected entities are recomputed (aggregate-stats Steps 4, 5 and 6).
 *      This is the only heavy read: one classification per run.
 *   3. Rule 4: the contracts that are the only copy of an annulled award are checked against the
 *      source, organ by organ and at most 2 requests at a time: is there a non-annulment record of the
 *      same award (same organ, supplier, amount and award date, any code)? Then, in a second short
 *      transaction, decide_contract_annulment_checks() stores the answers (row superseded when there
 *      is none, kept live when there is one), the decisions are applied and the entities recomputed.
 *   4. Prints the rows and the amount per reason.
 *
 * Run it after each contracts load. The load and the aggregation re-apply the stored decisions with
 * apply_contract_annulments(); this script refreshes the lines and the decisions themselves.
 *
 * Usage:
 *   npx tsx src/connectors/sync-contract-annulments.ts [--dry-run]
 *     [--organ=<name>] [--refresh] [--cache-dir=<dir>] [--skip-official-check]
 *     [--candidates-file=<file>]
 *
 *   Connection: DATABASE_URL (see src/lib/db.ts). Needs psql: the statements use \gset.
 *   --dry-run   does everything inside a transaction that is aborted: nothing is written.
 *   --organ     restricts decisions and changes to one organ.
 *   --refresh   ignores cached pages (they are still written).
 *   --cache-dir folder of the cached pages; default: the system temp folder (ANNULMENT_CACHE_DIR).
 *   --skip-official-check  leaves rule 4 undecided (those rows stay live and pending).
 *   --candidates-file      resumes rule 4 from the candidates a previous run saved.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLinesUpsertSql,
  buildOfficialCheckPayload,
  createFileCache,
  dollarQuoted,
  entityRecomputeSql,
  fetchAnnulmentLines,
  isCheckable,
  runOfficialChecks,
  type FetchLike,
  type OfficialCheckCandidate,
  type PageCache,
} from "../lib/contract-annulments";
import { databaseUrl } from "../lib/db";
import { createPsqlRunner } from "../lib/psql-runner";

const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;
const STATEMENT_TIMEOUT = process.env.AGG_STATEMENT_TIMEOUT || "3600s";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const option = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sqlText = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const realFetch: FetchLike = (url) =>
  fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Menjometre/1.0 (open data observatory)" },
    signal: AbortSignal.timeout(120_000),
  }) as unknown as ReturnType<FetchLike>;

const timer = () => {
  const started = Date.now();
  return () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
};

const eur = (n: number): string => `${(n / 1e6).toFixed(2)} M€`;

/** The lines of stdout that start with `prefix|`, without it. */
function tagged(output: string, prefix: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${prefix}|`))
    .map((line) => line.slice(prefix.length + 1));
}

async function main(): Promise<void> {
  const dryRun = flag("dry-run");
  const organ = option("organ");
  const organSql = organ ? sqlText(organ) : "NULL";

  // ── Target ────────────────────────────────────────────────────────────────
  databaseUrl(); // fails clearly when DATABASE_URL is missing
  const env = "db"; // label used in the names of the cached files
  console.log(`=== Official contract annulments (${dryRun ? "dry-run" : "write"}) ===`);
  console.log(`Target: DATABASE_URL${organ ? `, organ: ${organ}` : ""}`);

  const { runSQL } = createPsqlRunner();
  const prefix = `SET statement_timeout = '${STATEMENT_TIMEOUT}';\n`;
  const finish = dryRun ? "ABORT;" : "COMMIT;";

  let t = timer();
  const cacheDir = option("cache-dir") ?? process.env.ANNULMENT_CACHE_DIR ?? join(tmpdir(), "contract-annulments-cache");
  const candidatesFile = option("candidates-file");
  let candidates: OfficialCheckCandidate[] = [];

  if (candidatesFile) {
    // Resume from the candidates a previous run saved: no lines, no classification.
    candidates = JSON.parse(readFileSync(candidatesFile, "utf8")) as OfficialCheckCandidate[];
    console.log(`\nResuming from ${candidatesFile}: ${candidates.length} saved candidates.`);
  } else {
    // ── 1. The official lines ────────────────────────────────────────────────
    const fileCache = createFileCache(cacheDir, CACHE_MAX_AGE_MS);
    const cache: PageCache = flag("refresh") ? { read: () => null, write: fileCache.write } : fileCache;
    console.log(`\n[1] Reading the annulment lines (cache: ${cacheDir}${flag("refresh") ? ", refresh" : ""})...`);
    const fetched = await fetchAnnulmentLines({ fetchFn: realFetch, sleep, cache, log: console.log });
    console.log(
      `    ${fetched.lines.length} lines in ${fetched.pages} pages (${fetched.fromCache} from cache, ${fetched.retries} retries, ` +
        `${fetched.skipped} rows without url or code, ${fetched.repeatedLines} identical lines) in ${t()}`
    );
    if (fetched.lines.length === 0) throw new Error("The source returned no annulment lines: nothing to do, nothing written.");
    const byResultat = new Map<string, number>();
    for (const l of fetched.lines) byResultat.set(l.resultat || "(empty)", (byResultat.get(l.resultat || "(empty)") ?? 0) + 1);
    console.log(`    by resultat: ${[...byResultat].map(([k, n]) => `${k} ${n}`).join(", ")}; amount not a plain number: ${fetched.lines.filter((l) => l.amount === null).length}`);

    const upsert = buildLinesUpsertSql(fetched.lines).join("\n");

    // ── 2. Decide rules 1 to 3, apply, recompute ─────────────────────────────
    // One classification per run: decide_contract_annulments() is the only heavy read. It also hands back
    // the candidates of rule 4, which the source check below answers.
    t = timer();
    console.log(`\n[2] Rules 1 to 3: deciding and applying${dryRun ? " (inside a transaction that is aborted)" : ""}...`);
    const first = runSQL(`${prefix}BEGIN;
  ${upsert}
  SELECT 'LINES|' || count(*) FROM public.contract_official_annulments;
  SELECT 'DEC|' || decision_kind || '|' || decision_reason || '|' || n_rows || '|' || total_amount || '|' || n_changed || '|' || n_live || '|' || live_amount || '|' || COALESCE(detail::text, '')
    FROM public.decide_contract_annulments(${organSql}) ORDER BY 1;
  SELECT rows_superseded, rows_unsuperseded, entity_ids FROM public.apply_contract_annulments(${organSql}) \\gset
  SELECT 'APPLY|' || :rows_superseded || '|' || :rows_unsuperseded || '|' || COALESCE(array_length(:'entity_ids'::uuid[], 1), 0);
  ${entityRecomputeSql(":'entity_ids'::uuid[]")}
  ${finish}`);
    console.log(`    ${tagged(first, "LINES")[0]} lines in the table; done in ${t()}\n`);

    console.log("Decisions (decision, reason): rows decided · amount · rows live now · live amount · rows written");
    for (const row of tagged(first, "DEC")) {
      const [decision, reason, rows, amount, changed, live, liveAmount, ...rest] = row.split("|");
      console.log(
        `  ${decision.padEnd(11)} ${reason.padEnd(32)} ${rows.padStart(6)} · ${eur(Number(amount)).padStart(10)} · ${live.padStart(6)} live · ${eur(Number(liveAmount)).padStart(10)} · ${changed} written`
      );
      const detail = rest.join("|");
      if (reason === "pending_official_check" && detail) candidates = JSON.parse(detail) as OfficialCheckCandidate[];
    }
    const apply1 = tagged(first, "APPLY")[0]?.split("|") ?? [];
    console.log(`\nApplied: ${apply1[0]} rows superseded, ${apply1[1]} rows set live, ${apply1[2]} entities recomputed.`);

    mkdirSync(cacheDir, { recursive: true });
    const saved = join(cacheDir, `rule4-candidates-${env}${organ ? "-organ" : ""}.json`);
    writeFileSync(saved, JSON.stringify(candidates));
    console.log(`    candidates saved to ${saved} (use --candidates-file to resume from them)`);
  }

  // ── 3. Rule 4: the source check ──────────────────────────────────────────
  const checkable = candidates.filter(isCheckable);
  console.log(`\n[3] Rule 4: ${candidates.length} candidates (the only copy of an annulled award), ${checkable.length} can be checked.`);
  if (candidates.length > checkable.length) {
    console.log(`    ${candidates.length - checkable.length} lack an amount, an award date or a supplier: they stay pending.`);
  }
  if (flag("skip-official-check") || checkable.length === 0) {
    console.log(flag("skip-official-check") ? "    --skip-official-check: rule 4 stays undecided." : "    Nothing to check.");
    console.log(dryRun ? "\nDry-run: nothing was written." : "\nDone. Refresh the materialised views that read contracts.");
    return;
  }

  t = timer();
  const results = await runOfficialChecks(candidates, { fetchFn: realFetch, sleep, log: console.log }, { concurrency: 2 });
  const amountOf = new Map(candidates.map((c) => [`${c.organ}|${c.codiExpedient}|${c.keyCif}|${c.keySlug}|${c.lotNumber}`, c.amount ?? 0]));
  const sumOf = (list: typeof results): number =>
    list.reduce((n, r) => n + (amountOf.get(`${r.organ}|${r.codi_expedient}|${r.cif}|${r.entity_slug}|${r.lot_number}`) ?? 0), 0);
  const kept = results.filter((r) => r.found);
  const none = results.filter((r) => !r.found);
  const near = none.filter((r) => r.near_miss);
  console.log(`    ${results.length} answers in ${t()}:`);
  console.log(`      valid record exists, row kept live (kept_republished_absent_locally): ${kept.length} rows, ${eur(sumOf(kept))}`);
  console.log(`      no valid record, row superseded (no_valid_publication): ${none.length} rows, ${eur(sumOf(none))}`);
  console.log(`      of those, with a record of the same organ, supplier and amount but another award date: ${near.length}`);
  const candidateOf = new Map(candidates.map((c) => [`${c.organ}|${c.codiExpedient}|${c.keyCif}|${c.keySlug}|${c.lotNumber}`, c]));
  const answered = join(cacheDir, `rule4-answers-${env}${organ ? "-organ" : ""}.json`);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    answered,
    JSON.stringify(results.map((r) => ({ ...candidateOf.get(`${r.organ}|${r.codi_expedient}|${r.cif}|${r.entity_slug}|${r.lot_number}`), found: r.found, record_id: r.record_id, near_miss: r.near_miss })))
  );
  console.log(`      answers saved to ${answered}`);

  if (dryRun) {
    console.log("\nDry-run: nothing was written; rule 4 was only checked against the source.");
    return;
  }

  t = timer();
  const second = runSQL(`${prefix}BEGIN;
SELECT 'CHK|' || decision_kind || '|' || decision_reason || '|' || n_rows || '|' || n_changed
  FROM public.decide_contract_annulment_checks(${dollarQuoted(buildOfficialCheckPayload(results))}::jsonb) ORDER BY 1;
SELECT rows_superseded, rows_unsuperseded, entity_ids FROM public.apply_contract_annulments(${organSql}) \\gset
SELECT 'APPLY|' || :rows_superseded || '|' || :rows_unsuperseded || '|' || COALESCE(array_length(:'entity_ids'::uuid[], 1), 0);
${entityRecomputeSql(":'entity_ids'::uuid[]")}
COMMIT;`);
  console.log(`\n[4] Rule 4 decisions written in ${t()}:`);
  for (const row of tagged(second, "CHK")) {
    const [decision, reason, rows, changed] = row.split("|");
    console.log(`  ${decision.padEnd(11)} ${reason.padEnd(32)} ${rows.padStart(6)} rows · ${changed} written`);
  }
  const apply2 = tagged(second, "APPLY")[0]?.split("|") ?? [];
  console.log(`\nApplied: ${apply2[0]} rows superseded, ${apply2[1]} rows set live, ${apply2[2]} entities recomputed.`);
  console.log("\nDone. Refresh the materialised views that read contracts.");
}

main().catch((cause) => {
  process.stderr.write(`\nStopped: ${(cause as Error).message}\n`);
  process.exit(1);
});
