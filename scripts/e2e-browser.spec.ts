import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * The browser runtime — the one thing Node cannot stand in for.
 *
 * `scripts/e2e-crypto.ts` runs the shipped crypto module against a real
 * homeserver and proves the protocol works: Megolm sent and received, key
 * backup restored, emoji compared. It runs it under **Node**, and the
 * differences between Node and a browser are exactly where the remaining bugs
 * would live:
 *
 * - the crypto store is IndexedDB here and memory there, and persistence
 *   across a reload is the difference between keeping your history and losing
 *   it every time you refresh;
 * - the WASM is fetched by URL from a Vite-built bundle here and read off disk
 *   with `fs` there, and `optimizeDeps.exclude` is the only thing making the
 *   first work;
 * - none of the React wiring — the panel, the badge, the lock icon — exists in
 *   Node at all.
 *
 * So this is deliberately **narrow**. It does not reimplement the journey; the
 * journey already runs and is faster and steadier than any browser test. It
 * checks the handful of claims that are only true in a browser, and it says so
 * when it skips.
 *
 * Run it against a stack the harness left up:
 *
 *   ./scripts/e2e.sh --keep
 *   E2E_BASE=http://localhost:3999 \
 *   E2E_USERNAME=<from the harness output> \
 *   E2E_PASSWORD=<from the harness output> \
 *     pnpm test:browser
 *
 * It signs in as an account that already exists rather than registering one,
 * and that is not a shortcut taken for convenience. A stack left up by `--keep`
 * has by definition already run the journey stage, so its first account is
 * claimed and its setup code is spent: the sign-up form such an instance offers
 * asks for an **invite code**, not a setup code. The first version of this file
 * assumed a fresh instance and failed on that exact difference — four failures,
 * one cause, and three of them only because the first test never got a session.
 * Registration already has twenty-six checks against it one stage earlier. What
 * only a browser can answer is what happens *after* you are in.
 *
 * Browsers are not installed by `pnpm install`; run `pnpm exec playwright
 * install chromium` once. That download is the reason this is a separate
 * opt-in stage rather than part of preflight.
 */

const BASE = process.env.E2E_BASE ?? "http://localhost:3999";
/**
 * The sign-in identifier: a username, or an email if that's what you have.
 *
 * `E2E_EMAIL` is still honoured because older notes and shell history quote it,
 * and the field accepts either — but the harness now prints `E2E_USERNAME`,
 * since email is optional and a username is the one credential every account
 * is guaranteed to have.
 */
const IDENTIFIER = process.env.E2E_USERNAME ?? process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

/**
 * Reach the dashboard, signing in only if we aren't there already.
 *
 * Every test calls this instead of leaning on an earlier one having run.
 * Whether a second page in the same browser context is still signed in depends
 * on where the app keeps its session — and the third test in this file asserts
 * that the Matrix access token is deliberately kept *out* of web storage. "The
 * context will remember" is precisely the assumption this file should not be
 * quietly making about itself while testing that it isn't true.
 *
 * Driven through the real form rather than by seeding a cookie, because a
 * browser test that skips the browser's own login path is testing less than it
 * looks like it is.
 */
async function ensureSignedIn(page: Page): Promise<void> {
  await page.goto(BASE);

  // `/` renders three different pages depending on session state, and the
  // dashboard is none of them: signed out it is the sign-in form, signed in it
  // is a splash whose only real job is a button through to `/dashboard`
  // (Home.tsx, `if (user)`). So walk all three rather than assume which one
  // this landed on.
  // Anchored on the sign-in field's own placeholder. `/email/i` also matched
  // sign-up's "Email (optional)", so it was one form-state change away from
  // filling the wrong box — and it read as though this test signs in by email,
  // which it no longer does.
  const identifier = page.getByPlaceholder(/username or email/i);
  const enter = page
    .getByRole("button", { name: /enter dashboard|go to dashboard/i })
    .first();
  const dashboard = page.getByText(/^#|no channel selected/i).first();

  // `isVisible()` resolves immediately — it is a question about *now*, not a
  // wait, and the `{ timeout }` it accepts does nothing. Asking it of a page
  // still loading answers "no" and means it, which is how one version of this
  // helper skipped sign-in and then spent thirty seconds waiting for a
  // dashboard it had never asked for. Every `isVisible()` below runs only
  // after an `expect().toBeVisible()` has already settled the page.
  await expect(
    identifier.or(enter).or(dashboard).first(),
    "the app never rendered anything recognisable at " + BASE
  ).toBeVisible({ timeout: 30_000 });

  if (await identifier.isVisible().catch(() => false)) {
    // Stay on the sign-in view. The toggle below it leads to sign-up, which on
    // a used instance demands an invite code — see the note at the top.
    await identifier.fill(IDENTIFIER);
    await page.getByPlaceholder(/^password$/i).fill(PASSWORD);
    await page
      .getByRole("button", { name: /^sign in$/i })
      .first()
      .click();

    // Signing in does not move you anywhere. Waiting for the dashboard at this
    // point is waiting on a page that never shows one, and the failure reads
    // as bad credentials — which is what it claimed for two runs while the
    // credentials were fine. Wait for the splash instead.
    await expect(
      enter.or(dashboard).first(),
      "signed in, but the page never changed — are E2E_USERNAME and E2E_PASSWORD this stack's?"
    ).toBeVisible({ timeout: 30_000 });
  }

  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
  }

  await expect(
    dashboard,
    "signed in, but never arrived at the dashboard itself"
  ).toBeVisible({ timeout: 30_000 });
}

/** Whether the crypto store has been written for this account. */
async function cryptoDatabases(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    return databases
      .map(entry => entry.name ?? "")
      .filter(name => name.includes("sovrgn-crypto"));
  });
}

test.describe("the browser runtime", () => {
  test.skip(
    !IDENTIFIER || !PASSWORD,
    "needs E2E_USERNAME and E2E_PASSWORD from a running e2e stack"
  );

  let context: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("the crypto WASM loads from the built bundle", async () => {
    const page = await context.newPage();

    // The failure this catches is specific and total: Vite pre-bundling
    // rewrites `import.meta.url` inside the crypto package, its
    // `new URL("./pkg/....wasm", import.meta.url)` resolves to a path that
    // doesn't exist, and the whole crypto stack dies on a 404 that no
    // typecheck or Node test would ever see. `optimizeDeps.exclude` is the
    // only thing preventing it.
    const wasmRequests: string[] = [];
    const failures: string[] = [];
    page.on("response", response => {
      if (response.url().endsWith(".wasm")) {
        wasmRequests.push(`${response.status()} ${response.url()}`);
        if (!response.ok())
          failures.push(`${response.status()} ${response.url()}`);
      }
    });
    page.on("pageerror", error =>
      failures.push(`page error: ${error.message}`)
    );

    await ensureSignedIn(page);

    // The crypto client is behind a dynamic import gated on `clientMatrix`, so
    // it arrives after the dashboard does.
    await expect
      .poll(() => wasmRequests.length, {
        message: "the crypto WASM was never requested — is clientMatrix false?",
        timeout: 60_000,
      })
      .toBeGreaterThan(0);

    expect(failures, `WASM or page failures: ${failures.join(", ")}`).toEqual(
      []
    );
    await page.close();
  });

  test("the crypto store persists across a reload", async () => {
    const page = await context.newPage();
    await ensureSignedIn(page);

    await expect
      .poll(() => cryptoDatabases(page), {
        message: "no crypto database was created",
        timeout: 60_000,
      })
      .not.toEqual([]);

    const before = await cryptoDatabases(page);
    const deviceBefore = await page.evaluate(() =>
      localStorage.getItem("sovrgn.matrix.deviceId")
    );

    await page.reload();
    await expect
      .poll(() => cryptoDatabases(page), { timeout: 60_000 })
      .not.toEqual([]);

    const after = await cryptoDatabases(page);
    const deviceAfter = await page.evaluate(() =>
      localStorage.getItem("sovrgn.matrix.deviceId")
    );

    // Both halves matter and they pull in opposite directions. The store must
    // survive, because Megolm inbound sessions are the only copy of the
    // ability to read messages already received — a reset store is permanent
    // history loss on every refresh. The device id must be the *same* one, or
    // each reload mints an anonymous device and the pile-up that ADR 0008
    // stage 1 existed to stop is back.
    expect(
      after,
      "the crypto store was recreated rather than reopened"
    ).toEqual(before);
    expect(deviceAfter, "a reload minted a new device").toBe(deviceBefore);
    expect(deviceAfter).toMatch(/^SOVRGN_/);

    await page.close();
  });

  test("the access token is never persisted", async () => {
    const page = await context.newPage();
    await ensureSignedIn(page);
    await expect
      .poll(() => cryptoDatabases(page), { timeout: 60_000 })
      .not.toEqual([]);

    // Stage 3 kept the Matrix token in memory on purpose and stage 4 didn't
    // change it: keys persist, credentials don't. A stolen browser profile
    // should yield past message keys and not a live session (T21).
    const stored = await page.evaluate(() => ({
      local: Object.entries(localStorage).map(([k, v]) => `${k}=${v}`),
      session: Object.entries(sessionStorage).map(([k, v]) => `${k}=${v}`),
    }));

    const everything = [...stored.local, ...stored.session].join("\n");
    expect(
      everything,
      "something that looks like an access token is in web storage"
    ).not.toMatch(/syt_|accessToken|access_token/i);

    await page.close();
  });

  test("the encryption panel opens and reports a real state", async () => {
    const page = await context.newPage();

    // Collected because the first time this test got the panel open, the panel
    // said nothing at all: heading, blurb, "No devices reported yet", Close.
    // The readiness check had thrown into an empty catch, so the page knew
    // exactly what was wrong and the DOM carried no trace of it. Playwright
    // could only report "element(s) not found", which is true and useless.
    // The panel now says so itself; this keeps the underlying error reachable
    // from the run that fails, rather than from a second run added afterwards.
    const noise: string[] = [];
    page.on("pageerror", error => noise.push(`page error: ${error.message}`));
    page.on("console", message => {
      if (message.type() === "error") noise.push(`console: ${message.text()}`);
    });

    await ensureSignedIn(page);

    // None of this exists in Node: the panel, the readiness verdict it renders,
    // and the device list it reads out of the crypto machine.
    //
    // Asking for the button *by name* is the point of this line, not an
    // incidental way of finding it. The first version of this test guessed at
    // the panel already being open, took the honest `false` that `isVisible()`
    // returns for a page where it is not, and fell into a click that spent two
    // minutes waiting for a button that existed under no name at all — the
    // rail's controls carried their labels in hover tooltips, which Radix only
    // puts in the DOM while you are hovering. That was a real defect and is
    // fixed in Dashboard.tsx. Naming it here is what keeps it fixed: a control
    // nobody can ask for by name is a control a screen reader cannot reach,
    // and this one is the only way to device verification and a recovery key.
    const open = page.getByRole("button", { name: /^encryption$/i });
    await expect(
      open,
      "no button named 'Encryption' on the dashboard — either the instance reports encryption unavailable, or its label went back into a tooltip"
    ).toBeVisible({ timeout: 60_000 });
    await open.click();

    const panel = page.getByRole("dialog").filter({ hasText: /encryption/i });
    await expect(panel).toBeVisible({ timeout: 60_000 });
    // The verdict is computed from four independent checks against the crypto
    // machine. A panel that renders none of them has either not finished
    // asking or been told something it couldn't use, and the point of this
    // assertion is that "reports a real state" excludes both.
    //
    // Checked first and separately, because the previous version of this test
    // did not and passed on the failure message. The panel's "couldn't check"
    // text explains that the device has no recovery key — and the verdict
    // pattern below matches "recovery key". So the assertion went green on the
    // apology while the crypto stack was entirely unreachable, which is the
    // exact outcome the comment right above it swore off. A pattern loose
    // enough to match the error state is not a check on the working state.
    await expect(
      panel.getByText(/couldn't check this device's encryption/i),
      `the panel could not reach the crypto machine.\n${
        noise.length ? noise.join("\n") : "the page logged no errors"
      }`
    ).toHaveCount(0);

    // The five sentences `describeReadiness` can return, matched whole.
    //
    // The loose pattern this replaces asked for "recovery key" among other
    // things, which also appears in the panel's own explanatory copy — "Setting
    // up now gives you a recovery key..." — static text that renders whether or
    // not the crypto machine ever answered. So the pattern could be satisfied
    // by prose. It had already gone green once on the failure notice for the
    // same reason. A verdict is a specific sentence; asking for it loosely is
    // asking for something else.
    //
    // Anchored, so a paragraph that merely contains a headline doesn't count.
    // `server/e2ee.test.ts` checks this list against the source of truth.
    await expect(
      panel.getByText(
        /^(Encryption isn't set up on this account yet\.|This device isn't verified\.|Your account has no recovery key\.|Key backup is off\.|Encryption is set up and your keys are backed up\.)$/
      ),
      "the panel opened but reported no verdict"
    ).toBeVisible({ timeout: 30_000 });
    // The device list comes from `getUserDeviceInfo`, so a rendered row means
    // the machine answered. Exact match: the panel's own description ends
    // "...live on your devices", so the loose pattern matched two elements and
    // failed on strict mode rather than on anything about the product.
    await expect(
      panel.getByText("Your devices", { exact: true })
    ).toBeVisible();

    await page.close();
  });
});
