import { afterEach, describe, expect, it, vi } from "vitest";
import { createPsqlRunner, lastLine, type PsqlInvocation, type PsqlResult, type PsqlSpawn } from "../../src/lib/psql-runner";

const TEST_URL = "postgres://verifier:s3cret@db.example.test:5433/menjometre?sslmode=require";

function spawnReturning(result: PsqlResult, calls: PsqlInvocation[] = []): PsqlSpawn {
  return (invocation) => {
    calls.push(invocation);
    return result;
  };
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("Expected function to throw");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("psql runner - an ERROR on stderr is a failure even with exit status 0", () => {
  it("throws when psql exits 0 but stderr contains ERROR, preserving full diagnostics and SQL preview", () => {
    const runner = createPsqlRunner({
      spawn: spawnReturning({
        stdout: "1\n2",
        stderr: 'ERROR:  column "x" does not exist\nLINE 1: SELECT x;\n       ^',
        status: 0,
      }),
      dbUrl: TEST_URL,
    });

    const message = thrownMessage(() => runner.runSQL("SELECT 1; SELECT x; SELECT 2;"));

    expect(message).toContain('ERROR:  column "x" does not exist');
    expect(message).toContain("LINE 1: SELECT x;");
    expect(message).toContain("^");
    expect(message).toContain("SQL preview: SELECT 1; SELECT x; SELECT 2;");
  });
});

describe("psql runner", () => {
  it("ignores NOTICE with DETAIL and HINT", () => {
    const runner = createPsqlRunner({
      spawn: spawnReturning({
        stdout: "ok\n",
        stderr: "NOTICE:  algo\nDETAIL:  un detall\nHINT:  una pista",
        status: 0,
      }),
      dbUrl: TEST_URL,
    });

    expect(runner.runSQL("DO $$ BEGIN RAISE NOTICE 'algo'; END $$;")).toBe("ok");
  });

  it("ignores WARNING", () => {
    const runner = createPsqlRunner({
      spawn: spawnReturning({
        stdout: "ok",
        stderr: "WARNING:  alguna cosa",
        status: 0,
      }),
      dbUrl: TEST_URL,
    });

    expect(runner.runSQL("SELECT 1;")).toBe("ok");
  });

  it("throws on non-zero status with ERROR", () => {
    const runner = createPsqlRunner({
      spawn: spawnReturning({
        stdout: "",
        stderr: "ERROR:  syntax error at or near \"bad\"",
        status: 3,
      }),
      dbUrl: TEST_URL,
    });

    expect(() => runner.runSQL("SELECT bad")).toThrow(/ERROR:  syntax error/);
  });

  it("allowFailure warns, does not throw, and returns stdout", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = createPsqlRunner({
      spawn: spawnReturning({
        stdout: "partial stdout\n",
        stderr: 'ERROR:  column "x" does not exist\nLINE 1: SELECT x;\n       ^',
        status: 0,
      }),
      dbUrl: TEST_URL,
    });

    expect(runner.runSQL("SELECT x;", { allowFailure: true })).toBe("partial stdout");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("SQL allowed failure");
  });

  it("returns trimmed stdout when stderr is empty", () => {
    const runner = createPsqlRunner({
      spawn: spawnReturning({
        stdout: "  value\n",
        stderr: "",
        status: 0,
      }),
      dbUrl: TEST_URL,
    });

    expect(runner.runSQL("SELECT 1;")).toBe("value");
  });

  it("throws on spawn errors", () => {
    const runner = createPsqlRunner({
      spawn: spawnReturning({
        stdout: "",
        stderr: "",
        status: null,
        error: new Error("ENOBUFS"),
      }),
      dbUrl: TEST_URL,
    });

    expect(() => runner.runSQL("SELECT 1;")).toThrow(/ENOBUFS/);
  });

  it("throws on psql connection errors", () => {
    const runner = createPsqlRunner({
      spawn: spawnReturning({
        stdout: "",
        stderr: "psql: error: connection to server at \"localhost\" failed",
        status: 2,
      }),
      dbUrl: TEST_URL,
    });

    expect(() => runner.runSQL("SELECT 1;")).toThrow(/connection to server/);
  });

  it("adds -X and ON_ERROR_STOP=1 and passes the connection only through libpq variables", () => {
    const calls: PsqlInvocation[] = [];
    const runner = createPsqlRunner({
      spawn: spawnReturning({ stdout: "", stderr: "", status: 0 }, calls),
      dbUrl: TEST_URL,
    });
    expect(runner.psqlCmd()).toContain("-X");
    expect(runner.psqlCmd()).toContain("-v ON_ERROR_STOP=1");
    expect(runner.psqlCmd()).toContain("DATABASE_URL");
    expect(runner.psqlCmd()).not.toContain("s3cret");
    runner.runSQLFile("SELECT 1;");
    expect(calls[0].executable).toBe("psql");
    expect(calls[0].argv).toEqual(["-X", "-t", "-A", "-v", "ON_ERROR_STOP=1"]);
    expect(calls[0].argv.join(" ")).not.toContain("postgres://");
    expect(calls[0].env).toEqual({
      PGHOST: "db.example.test",
      PGPORT: "5433",
      PGUSER: "verifier",
      PGPASSWORD: "s3cret",
      PGDATABASE: "menjometre",
      PGSSLMODE: "require",
    });
    expect(calls[0].input).toBe("SELECT 1;");
    expect(calls[0].displayCmd).not.toContain("s3cret");
    // Must exceed the longest statement_timeout passed through it (3600s in
    // aggregate-stats); if they were equal, Node would kill psql before
    // Postgres could report the timeout.
    expect(calls[0].timeoutMs).toBe(7_200_000);
  });

  it("reads DATABASE_URL from the environment and fails clearly without it", () => {
    const calls: PsqlInvocation[] = [];
    vi.stubEnv("DATABASE_URL", "postgres://u@localhost/db_from_env");
    const runner = createPsqlRunner({ spawn: spawnReturning({ stdout: "", stderr: "", status: 0 }, calls) });
    runner.runSQL("SELECT 1;");
    expect(calls[0].env.PGDATABASE).toBe("db_from_env");
    expect(calls[0].env.PGHOST).toBe("localhost");

    vi.stubEnv("DATABASE_URL", "");
    expect(() => runner.runSQL("SELECT 1;")).toThrow(/DATABASE_URL is not set/);
    vi.unstubAllEnvs();
  });

  it("collapses whitespace and truncates SQL preview to 500 characters", () => {
    const runner = createPsqlRunner({
      spawn: spawnReturning({
        stdout: "",
        stderr: "ERROR:  broken",
        status: 3,
      }),
      dbUrl: TEST_URL,
    });
    const sql = `SELECT     ${Array.from({ length: 700 }, (_, i) => `col_${i}`).join("\n\t,     ")}`;

    const message = thrownMessage(() => runner.runSQL(sql));
    const preview = message.match(/SQL preview: (.*)\nstderr:/s)?.[1] ?? "";

    expect(preview).toHaveLength(500);
    expect(preview).not.toMatch(/\s{2,}/);
  });
});

describe("lastLine - the SET command tag before a value", () => {
  it("returns the value when psql prefixes the SET command tag", () => {
    expect(lastLine("SET\n21442077")).toBe("21442077");
  });

  it("returns the value unchanged when there is no prefix", () => {
    expect(lastLine("21442077")).toBe("21442077");
  });

  it("ignores trailing newlines and blank lines", () => {
    expect(lastLine("SET\n0\n\n")).toBe("0");
  });

  it("returns an empty string for empty output so the caller can fail loud", () => {
    expect(lastLine("")).toBe("");
    expect(lastLine("\n \n")).toBe("");
  });

  it("keeps a non-numeric last line intact instead of hiding it", () => {
    expect(lastLine("SET\nSET")).toBe("SET");
  });
});
