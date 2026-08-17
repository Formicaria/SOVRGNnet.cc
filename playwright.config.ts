import { defineConfig } from "@playwright/test";

/**
 * Browser tests, deliberately outside preflight.
 *
 * They need Chromium (~150MB, installed separately) and a stack the e2e
 * harness left running, so wiring them into `pnpm preflight` would turn a
 * 20-second check into a download and make the fast path slow enough that
 * people stop running it. That trade has already been made once in this
 * repository, in favour of preflight staying fast, and it holds here.
 *
 *   ./scripts/e2e.sh --keep
 *   pnpm exec playwright install chromium      # once
 *   E2E_BASE=http://localhost:3999 E2E_SETUP_TOKEN=… pnpm exec playwright test
 *
 * The spec skips itself, loudly, without E2E_SETUP_TOKEN — a browser suite
 * that silently passes against nothing is worse than one that isn't run.
 */
export default defineConfig({
  testDir: "./scripts",
  testMatch: /.*\.spec\.ts$/,
  // Serial. The tests share one browser context on purpose: the second and
  // third depend on the crypto store the first created, which is the whole
  // point of testing persistence.
  workers: 1,
  fullyParallel: false,
  // Crypto setup involves key uploads, a sync, and WASM instantiation. Generous
  // here and bounded per-assertion in the spec, so a failure says which step.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // No retries. A flaky crypto test that passes on the second attempt is a
  // crypto bug being papered over.
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE ?? "http://localhost:3999",
    // The harness serves plain HTTP on localhost.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    video: "off",
  },
});
