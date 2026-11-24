import { describe, expect, it } from "vitest";
import { significantStderr } from "../../src/lib/psql-runner";

describe("significantStderr classification", () => {
  const benignCases: Array<[string, string]> = [
    ["NOTICE", "NOTICE:  algo"],
    ["INFO", "INFO:  una dada"],
    ["DEBUG", "DEBUG:  traça"],
    ["LOG", "LOG:  missatge"],
    ["WARNING", "WARNING:  alguna cosa"],
    ["DETAIL", "DETAIL:  un detall"],
    ["HINT", "HINT:  una pista"],
    ["CONTEXT", "CONTEXT:  PL/pgSQL function inline_code_block line 1"],
    ["LINE", "LINE 1: SELECT falla_aqui;"],
    ["QUERY", "QUERY:  SELECT 1"],
    ["STATEMENT", "STATEMENT:  SELECT 1"],
    ["cursor", "       ^"],
    ["NOTICE from an \\i file", 'psql:sql/schema/030-contract-dedup.sql:33: NOTICE:  constraint "x" does not exist, skipping'],
  ];

  it.each(benignCases)("does not treat %s lines as significant", (_name, stderr) => {
    expect(significantStderr(stderr)).toBe("");
  });

  const significantCases: Array<[string, string]> = [
    ["ERROR", "ERROR:  column \"x\" does not exist"],
    ["FATAL", "FATAL:  database system is starting up"],
    ["PANIC", "PANIC:  could not write to log file"],
    ["psql connection error", "psql: error: connection to server at \"localhost\" failed"],
    ["missing executable", "Error: spawn psql ENOENT"],
    ["ERROR from an \\i file", 'psql:sql/schema/010-tables.sql:12: ERROR:  relation "x" does not exist'],
    ["unknown stderr", "unexpected stderr output"],
  ];

  it.each(significantCases)("treats %s as significant", (_name, stderr) => {
    expect(significantStderr(stderr)).toBe(stderr.trim());
  });

  it("treats mixed NOTICE/DETAIL/ERROR/HINT output as significant because of ERROR", () => {
    expect(
      significantStderr("NOTICE:  algo\nDETAIL:  un detall\nERROR:  de veritat\nHINT:  una pista")
    ).toBe("ERROR:  de veritat");
  });
});
