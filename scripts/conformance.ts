/**
 * Conformance runner.
 *
 *   pnpm conformance https://sovrgnnet.cc
 *   pnpm conformance http://localhost:3000 --json
 *
 * Exits 0 if the instance conforms, 1 if it doesn't. Warnings never fail it.
 *
 * The checks themselves live in shared/conformance.ts and are pure, so they're
 * tested without a server. This file only does I/O.
 */

import { runConformance, summarize, type Probe, type Probes } from "../shared/conformance";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

const TIMEOUT_MS = 10_000;

async function probe(base: string, path: string): Promise<Probe> {
  const url = new URL(path, base).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      // No credentials: discovery must work for a client that has never seen
      // this instance, which is the case the suite exists to verify.
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    let body: unknown = null;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    return { ok: response.ok, status: response.status, body, headers };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      body: null,
      error: message.includes("abort") ? `timed out after ${TIMEOUT_MS / 1000}s` : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const target = args.find(a => !a.startsWith("--"));

  if (!target) {
    console.error("Usage: pnpm conformance <url> [--json]");
    console.error("       pnpm conformance https://sovrgnnet.cc");
    process.exit(2);
  }

  let base: string;
  try {
    base = new URL(target.includes("://") ? target : `https://${target}`).toString();
  } catch {
    console.error(`Not a usable address: ${target}`);
    process.exit(2);
  }

  const instance = await probe(base, "/api/instance");

  /*
   * The homeserver address the instance advertises, read back out of the
   * descriptor so that it can actually be tried.
   *
   * The only probe here whose URL isn't a fixed path on the target, which is
   * why it is built after the others rather than beside them — the address
   * isn't known until the instance has been asked for it. Left undefined when
   * there is nothing to try, and the suite reports that as unchecked rather
   * than as fine.
   */
  const advertisedMatrix = (() => {
    const body = instance.body as { matrix?: { baseUrl?: unknown } } | null;
    const url = body?.matrix?.baseUrl;
    return typeof url === "string" && url.length > 0 ? url : null;
  })();

  const probes: Probes = {
    instance,
    capabilities: await probe(base, "/api/capabilities"),
    version: await probe(base, "/api/version"),
    health: await probe(base, "/health"),
    ready: await probe(base, "/ready"),
    matrixVersions: advertisedMatrix
      ? await probe(advertisedMatrix, "/_matrix/client/versions")
      : undefined,
  };

  const results = runConformance(probes);
  const summary = summarize(results);

  if (json) {
    console.log(JSON.stringify({ target: base, summary, results }, null, 2));
    process.exit(summary.conformant ? 0 : 1);
  }

  console.log(`\n${BOLD}SOVRGN protocol conformance${RESET}`);
  console.log(`${DIM}${base}${RESET}\n`);

  for (const result of results) {
    const mark =
      result.status === "pass"
        ? `${GREEN}✓${RESET}`
        : result.status === "fail"
          ? `${RED}✗${RESET}`
          : result.status === "warn"
            ? `${YELLOW}!${RESET}`
            : `${DIM}-${RESET}`;

    console.log(`  ${mark} ${result.title}`);
    if (result.status !== "pass") {
      console.log(`      ${DIM}${result.detail}${RESET}`);
    }
  }

  console.log("");
  const tally = `${summary.passed} passed, ${summary.failed} failed, ${summary.warned} warnings`;

  if (summary.conformant) {
    console.log(`${GREEN}${BOLD}Conformant.${RESET} ${DIM}${tally}${RESET}`);
    if (summary.warned > 0) {
      console.log(`${DIM}Warnings are advice, not violations.${RESET}`);
    }
  } else {
    console.log(`${RED}${BOLD}Not conformant.${RESET} ${DIM}${tally}${RESET}`);
    console.log(`${DIM}See docs/PROTOCOL.md for what each check expects.${RESET}`);
  }
  console.log("");

  process.exit(summary.conformant ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(2);
});
