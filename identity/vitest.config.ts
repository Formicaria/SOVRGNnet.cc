import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Matches identity/tsconfig.json. Without it these tests import the
      // shared crypto through a path Vite cannot resolve, and the failure
      // reads like a missing package rather than a missing alias.
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
    },
  },
  test: {
    /**
     * File parallelism off, deliberately. Both database suites (routes.db,
     * oauth.db) truncate the same throwaway Postgres between cases; run in
     * parallel — which vitest does per *file* by default — they delete each
     * other's rows mid-test: a duplicate email registers with 201 because
     * the first account was truncated between the two calls, and a planted
     * OAuth state is gone before it's asserted. Low-core machines ran the
     * files serially in one worker and never saw it; a 16-thread box found
     * it on the first full preflight after the second db suite landed. The
     * whole workspace runs in under three seconds serial.
     */
    fileParallelism: false,
  },
});
