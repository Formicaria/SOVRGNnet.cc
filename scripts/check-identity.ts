#!/usr/bin/env tsx
/**
 * Can an independent instance use this identity provider?
 *
 *   pnpm check:identity                          # https://id.sovrgnnet.cc
 *   pnpm check:identity https://id.example.com   # somebody else's
 *
 * The live counterpart to server/identityIssuer.test.ts. That file tests the
 * rules against a document captured from production; this one fetches the
 * document. Both matter, and neither replaces the other: the test runs
 * everywhere including on a train, and this catches the day production stops
 * matching what the test assumes.
 *
 * Exits 0 if a server could use this issuer, 1 if it could not.
 */

import { checkIssuerJwks } from "../shared/identityIssuer";
import { IDENTITY_ORIGIN } from "../shared/identityOrigin";

const BOLD = "[1m";
const DIM = "[2m";
const RED = "[31m";
const GREEN = "[32m";
const RESET = "[0m";

async function main(): Promise<void> {
  const origin = (process.argv[2] ?? IDENTITY_ORIGIN).replace(/\/+$/, "");
  const url = `${origin}/.well-known/jwks.json`;

  console.log(`\n  ${BOLD}Identity provider${RESET} ${DIM}${origin}${RESET}\n`);

  let response: Response;
  try {
    // A short timeout on purpose. This is the check you run when something is
    // wrong, and hanging for the default two minutes is its own failure.
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    console.error(`  ${RED}✗${RESET} Could not reach ${url}`);
    console.error(`    ${DIM}${error instanceof Error ? error.message : error}${RESET}`);
    console.error(
      `    ${DIM}An instance that cannot fetch this cannot accept SSO sign-ins.${RESET}`
    );
    console.error(
      `    ${DIM}Existing sessions are unaffected — servers verify from a cached key.${RESET}\n`
    );
    process.exit(1);
  }

  if (!response.ok) {
    console.error(`  ${RED}✗${RESET} ${url} answered ${response.status}`);
    if (response.status === 404 || response.status === 405) {
      console.error(
        `    ${DIM}That is what a static site returns. Check the origin is the${RESET}`
      );
      console.error(
        `    ${DIM}identity service and not the marketing site — the two were${RESET}`
      );
      console.error(`    ${DIM}confused once, and SSO was broken everywhere.${RESET}`);
    }
    console.error("");
    process.exit(1);
  }

  let document: unknown;
  try {
    document = await response.json();
  } catch {
    console.error(`  ${RED}✗${RESET} ${url} did not return JSON`);
    console.error(
      `    ${DIM}A 200 with HTML is the signature of a static host answering${RESET}`
    );
    console.error(`    ${DIM}for a path it does not have.${RESET}\n`);
    process.exit(1);
  }

  const assessment = checkIssuerJwks(document);

  for (const problem of assessment.problems) {
    console.error(`  ${RED}✗${RESET} ${problem.headline}`);
    console.error(`    ${DIM}${problem.detail}${RESET}`);
  }

  if (!assessment.usable) {
    console.error(`\n  ${RED}No instance could use this issuer.${RESET}\n`);
    process.exit(1);
  }

  console.log(`  ${GREEN}✓${RESET} JWKS served and parseable`);
  console.log(
    `  ${GREEN}✓${RESET} ${assessment.kids.length} usable key(s): ${assessment.kids.join(", ")}`
  );
  console.log(`  ${GREEN}✓${RESET} No private material published`);

  if (assessment.problems.length > 0) {
    console.log(
      `\n  ${DIM}Usable, with the problems above. Fix them before they become${RESET}`
    );
    console.log(`  ${DIM}the reason a rotation goes wrong.${RESET}\n`);
    process.exit(1);
  }

  console.log(
    `\n  ${DIM}An independent instance pointed at this issuer can verify its${RESET}`
  );
  console.log(
    `  ${DIM}tokens, and needs nothing else from it afterwards.${RESET}\n`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
