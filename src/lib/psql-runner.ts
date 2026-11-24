import { spawnSync } from "child_process";
import { libpqEnv } from "./db";

const MAX_BUFFER = 50 * 1024 * 1024;
// Rule: the process timeout must ALWAYS exceed the longest statement_timeout
// passed to it. Otherwise Node kills the child just before Postgres can answer,
// and the error arrives as an opaque spawn failure instead of "canceling
// statement due to statement timeout". 7200s leaves a margin over 3600s.
const DEFAULT_PROCESS_TIMEOUT_MS = 7_200_000;

export interface PsqlResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}

export interface PsqlInvocation {
  executable: string;
  argv: string[];
  /** libpq variables (PGHOST, PGUSER...) added to the environment of psql. */
  env: Record<string, string>;
  input?: string;
  displayCmd: string;
  timeoutMs: number;
  /** Largest stdout/stderr accepted from psql, in bytes. */
  maxBuffer?: number;
}

export type PsqlSpawn = (invocation: PsqlInvocation) => PsqlResult;

export interface RunSQLOpts {
  allowFailure?: boolean;
}

export interface PsqlFailure {
  cmd: string;
  sql: string;
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
  message: string;
}

interface PsqlRunnerOpts {
  spawn?: PsqlSpawn;
  /** Connection string; defaults to the DATABASE_URL environment variable. */
  dbUrl?: string;
  onAllowedFailure?: (failure: PsqlFailure) => void;
  warnAllowedFailures?: boolean;
  processTimeoutMs?: number;
  /** Largest psql output accepted, in bytes (default 50 MB). */
  maxBufferBytes?: number;
}

function defaultSpawn(invocation: PsqlInvocation): PsqlResult {
  const result = spawnSync(invocation.executable, invocation.argv, {
    input: invocation.input,
    env: { ...process.env, ...invocation.env },
    encoding: "utf8",
    shell: false,
    maxBuffer: invocation.maxBuffer ?? MAX_BUFFER,
    timeout: invocation.timeoutMs,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    error: result.error,
  };
}

// Fatal severities: psql only exits non-zero and stops later statements
// when ON_ERROR_STOP is active.
const FATAL_SEVERITY = /\b(?:ERROR|FATAL|PANIC):/;

// Benign severities: these can land on stderr without making the statement fail.
const BENIGN_SEVERITY_PREFIX = /^(?:NOTICE|INFO|DEBUG|LOG|WARNING):/;

// Continuation lines: DETAIL/HINT/LINE/^ carry useful diagnostics, but they
// must not decide severity.
const CONTINUATION_PREFIX = /^(?:DETAIL|HINT|CONTEXT|QUERY|STATEMENT):/;
const LINE_PREFIX = /^LINE\s+\d+:/;
const CURSOR_LINE = /^\^+$/;

// Statements read through `\i file` get their messages prefixed with the file
// and line ("psql:sql/x.sql:33: NOTICE:  ..."); the severity follows it.
const FILE_LOCATION_PREFIX = /^psql:[^:\s]+:\d+:\s*/;

export function significantStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((raw) => {
      const line = raw.replace(FILE_LOCATION_PREFIX, "");
      if (CONTINUATION_PREFIX.test(line) || LINE_PREFIX.test(line) || CURSOR_LINE.test(line)) {
        return false;
      }
      if (FATAL_SEVERITY.test(line)) {
        return true;
      }
      if (BENIGN_SEVERITY_PREFIX.test(line)) {
        return false;
      }
      return true;
    })
    .join("\n");
}

/**
 * Last non-empty line of psql output.
 *
 * psql prints the command tag of EVERY statement it receives ("SET", "BEGIN",
 * "COMMIT"...). The pipeline scripts prefix "SET statement_timeout = ...;" to
 * each query, so a count arrives as "SET\n21442077". Parsing the whole output
 * as one number would fail; the value is always the last non-empty line.
 *
 * Only for value queries that end in a SELECT: a DML statement with RETURNING
 * prints the rows first and the tag ("UPDATE 12") after, and there the last
 * line would be the tag, not the value.
 */
export function lastLine(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

function sqlPreview(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, 500);
}

function formatSqlFailure(sql: string, detail: string): string {
  return `psql failed. SQL preview: ${sqlPreview(sql)}\nstderr:\n${detail}`;
}

function commandFailed(result: PsqlResult, stderr: string): boolean {
  return Boolean(result.error) || result.status !== 0 || significantStderr(stderr).length > 0;
}

function quoteDisplayArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) {
    return arg;
  }
  return JSON.stringify(arg);
}

function formatDisplayCmd(executable: string, argv: string[]): string {
  return [executable, ...argv].map(quoteDisplayArg).join(" ");
}

export function createPsqlRunner(opts: PsqlRunnerOpts = {}) {
  const spawn = opts.spawn ?? defaultSpawn;
  const warnAllowedFailures = opts.warnAllowedFailures ?? true;
  const processTimeoutMs = opts.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  const PSQL_ARGV = ["-X", "-t", "-A", "-v", "ON_ERROR_STOP=1"];

  function psqlInvocation(input?: string): PsqlInvocation {
    // The connection travels as libpq environment variables, never as an
    // argument: it does not show up in a process list or in an error message.
    const dbUrl = opts.dbUrl || process.env.DATABASE_URL || undefined;
    return {
      executable: "psql",
      argv: [...PSQL_ARGV],
      env: libpqEnv(dbUrl),
      input,
      displayCmd: `${formatDisplayCmd("psql", PSQL_ARGV)} (connection: DATABASE_URL)`,
      timeoutMs: processTimeoutMs,
      maxBuffer: opts.maxBufferBytes,
    };
  }

  function psqlCmd(): string {
    return `${formatDisplayCmd("psql", PSQL_ARGV)} (connection: DATABASE_URL)`;
  }

  function handleResult(label: string, cmd: string, sql: string, result: PsqlResult, runOpts: RunSQLOpts): string {
    const stdout = (result.stdout ?? "").trim();
    const stderr = (result.stderr ?? "").trim();

    if (!commandFailed(result, stderr)) {
      return stdout;
    }

    const detail = stderr || result.error?.message || stdout || "unknown psql failure";
    const message = formatSqlFailure(sql, detail);

    if (runOpts.allowFailure) {
      const failure: PsqlFailure = {
        cmd,
        sql,
        stdout,
        stderr,
        status: result.status,
        error: result.error,
        message,
      };
      opts.onAllowedFailure?.(failure);
      if (warnAllowedFailures) {
        console.warn(`  ${label} allowed failure: ${message}`);
      }
      return stdout;
    }

    throw new Error(message);
  }

  function runSQL(sql: string, runOpts: RunSQLOpts = {}): string {
    const invocation = psqlInvocation(sql);
    return handleResult("SQL", invocation.displayCmd, sql, spawn(invocation), runOpts);
  }

  function runSQLFile(sql: string, runOpts: RunSQLOpts = {}): string {
    const invocation = psqlInvocation(sql);
    return handleResult("SQL file", invocation.displayCmd, sql, spawn(invocation), runOpts);
  }

  return { runSQL, runSQLFile, psqlCmd };
}
