import { describe, expect, it } from "vitest";
import { RAISC_SODA_ENDPOINT, buildUpdatedSinceWhere } from "../../src/lib/soda/raisc-client";

describe("RAISC SODA client", () => {
  it("reads the official RAISC dataset on the Generalitat open-data portal", () => {
    expect(RAISC_SODA_ENDPOINT).toBe("https://analisi.transparenciacatalunya.cat/resource/s9xt-n979.json");
  });

  it("builds the incremental window on the Socrata :updated_at field", () => {
    expect(buildUpdatedSinceWhere("2026-11-01")).toBe(":updated_at > '2026-11-01T00:00:00'");
  });

  it("accepts only a plain date, so nothing else reaches the SoQL query", () => {
    expect(() => buildUpdatedSinceWhere("2026-11-01' OR 1=1 --")).toThrow(/YYYY-MM-DD/);
    expect(() => buildUpdatedSinceWhere("1/11/2026")).toThrow(/YYYY-MM-DD/);
    expect(() => buildUpdatedSinceWhere("")).toThrow(/YYYY-MM-DD/);
  });
});
