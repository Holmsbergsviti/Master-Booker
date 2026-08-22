import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The live audit hits Firestore and needs a service account key.
    // `npm test` must run offline on any machine; use `npm run test:live`.
    exclude: ["tests/live/**"],
    // Deliberately NOT Belgrade. The shared code pins its own zone, so
    // running the suite somewhere else is what proves it: a helper that
    // quietly reached for the runtime's local time would fail here and
    // pass in production, which is the worst way round.
    env: { TZ: "America/New_York" }
  }
});
