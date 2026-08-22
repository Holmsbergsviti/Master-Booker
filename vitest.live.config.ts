import { defineConfig } from "vitest/config";

/** The live audit only. Read-only, needs serviceAccountKey.json, and is
 *  kept out of the default suite so `npm test` stays offline. */
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    env: { TZ: "America/New_York" },
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
