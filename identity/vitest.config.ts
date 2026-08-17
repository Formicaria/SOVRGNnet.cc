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
});
