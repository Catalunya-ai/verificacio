import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRAGMENTATION_BAND_MAX_EUR,
  FRAGMENTATION_BAND_MIN_EUR,
  FRAGMENTATION_MIN_CONTRACTS,
} from "../../src/lib/scoring-config";

/**
 * The fragmentation band, said once.
 *
 * The band and the minimum number of contracts live in scoring-config, and
 * this pins the public methodology to them: move the band and this test makes
 * you move the sentence that announces it.
 */

const root = resolve(__dirname, "..", "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const METHODOLOGY = read("METODOLOGIA.md");
const NETWORK = read("src/pipeline/analyze-contract-network.ts");

/** Euros as the methodology writes them: thousands separated by a dot. */
const euros = (value: number) => value.toLocaleString("ca-ES");

describe("the fragmentation band", () => {
  it("is stated in METODOLOGIA.md exactly as the pipeline counts it", () => {
    expect(METHODOLOGY).toContain(
      `${FRAGMENTATION_MIN_CONTRACTS} o més contractes a la franja ` +
        `${euros(FRAGMENTATION_BAND_MIN_EUR)}–${euros(FRAGMENTATION_BAND_MAX_EUR)} €`
    );
  });

  /** The legal anchor is the point of the sentence and travels with it. */
  it("keeps the legal reference the sentence is built on", () => {
    expect(METHODOLOGY).toContain("llindar");
    expect(METHODOLOGY).toContain("LCSP 9/2017");
  });

  it("does not announce a band the pipeline never used", () => {
    expect(METHODOLOGY).not.toContain("12.000-15.000");
    expect(METHODOLOGY).not.toContain("5 o més contractes");
  });

  it("is read from the shared configuration by the network analysis", () => {
    expect(NETWORK).toContain("FRAGMENTATION_BAND_MIN_EUR");
    expect(NETWORK).toContain("FRAGMENTATION_BAND_MAX_EUR");
    // The literals are gone, in both the SQL and the TypeScript spellings.
    expect(NETWORK).not.toMatch(/\b14[_.]?900\b/);
  });

  it("keeps the entity floor in the query that applies it", () => {
    expect(NETWORK).toContain("FRAGMENTATION_MIN_CONTRACTS");
  });
});
