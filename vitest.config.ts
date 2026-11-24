import { defineConfig } from "vitest/config";

// Unit tests only: no network, no database. They exercise the pure parsers and
// mappers, the SQL generators with fake drivers, and read the SQL of the
// pipeline to check it against the published configuration.
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
