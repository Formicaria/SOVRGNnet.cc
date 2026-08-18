/**
 * The sign-in pages, served by the identity service itself.
 *
 * Not part of the sovrgnnet.cc static site, for two reasons: this needs to be
 * same-origin with the API so the session cookie works without CORS, and the
 * marketing site ships no JavaScript at all and shouldn't start now.
 *
 * Plain HTML with a little inline script. A build step for two forms would be
 * an odd thing to maintain.
 */

const STYLE = `
  :root {
    --bg:#0a0614; --panel:#170f2b; --border:#2c1f4d; --text:#e8e3f5;
    --muted:#9c92b8; --accent:#a855f7; --warn:#fbbf24; --danger:#f87171;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color-scheme: dark;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
       line-height:1.6;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{width:min(420px,100%);background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:32px}
  .card.wide{width:min(640px,100%)}
  .server{display:flex;gap:12px;align-items:center;padding:13px;margin-top:10px;
          border:1px solid var(--border);border-radius:11px;background:#0d0818}
  .server .badge{width:42px;height:42px;border-radius:12px;background:#241a3d;display:flex;
                 align-items:center;justify-content:center;font-weight:700;font-size:.85rem;flex:0 0 auto}
  .server .meta{flex:1;min-width:0}
  .server .meta strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .server .meta small{display:block;color:var(--muted);font-family:var(--mono);font-size:.72rem;
                      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .server .revoke{flex:0 0 auto}
  .server .open{margin:0;width:auto;padding:8px 18px;flex:0 0 auto;text-decoration:none;
                display:inline-block;background:var(--accent);color:#fff;border-radius:9px;
                font-weight:600;font-size:.88rem}
  .server .open:hover{filter:brightness(1.1)}
  .addrow{display:flex;gap:8px;margin-top:10px}
  .addrow input{flex:1}
  .addrow button{width:auto;margin-top:0;padding:10px 16px}
  h1{font-size:1.35rem;margin-bottom:6px;letter-spacing:-.01em}
  p.sub{color:var(--muted);font-size:.93rem;margin-bottom:22px}
  label{display:block;font-size:.78rem;color:var(--muted);margin:14px 0 5px}
  input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);
        background:#0d0818;color:var(--text);font-size:.95rem}
  input:focus{outline:2px solid var(--accent);outline-offset:-1px}
  button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:9px;cursor:pointer;
         background:var(--accent);color:#fff;font-weight:600;font-size:.95rem}
  button:disabled{opacity:.5;cursor:default}
  .alt{margin-top:16px;text-align:center;font-size:.87rem;color:var(--muted)}
  .alt a{color:var(--accent);text-decoration:none}
  .err{margin-top:14px;padding:9px 12px;border-radius:8px;font-size:.87rem;
       background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.3);color:var(--danger)}
  .target{display:flex;gap:12px;align-items:center;padding:12px;margin-bottom:20px;
          border:1px solid var(--border);border-radius:10px;background:#0d0818}
  .target .badge{width:38px;height:38px;border-radius:11px;background:#241a3d;display:flex;
                 align-items:center;justify-content:center;font-weight:700;font-size:.8rem;flex:0 0 auto}
  .target small{display:block;color:var(--muted);font-family:var(--mono);font-size:.72rem}
  .note{margin-top:18px;font-size:.8rem;color:var(--muted);border-top:1px solid var(--border);padding-top:14px}
  .codes{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:16px 0;font-family:var(--mono);font-size:.9rem}
  .codes span{background:#0d0818;border:1px solid var(--border);border-radius:6px;padding:7px;text-align:center}
  .linky{background:none;border:0;color:var(--muted);font-size:.85rem;cursor:pointer;
         text-decoration:underline;padding:0;width:auto;margin:0}
  .linky:hover{color:var(--text)}
  .warn{margin-top:14px;padding:11px 13px;border-radius:8px;font-size:.85rem;
        background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);color:var(--warn)}
  .or{display:flex;align-items:center;gap:10px;margin:18px 0 4px;color:var(--muted);font-size:.78rem}
  .or::before,.or::after{content:"";flex:1;height:1px;background:var(--border)}
  .provider{display:flex;align-items:center;justify-content:center;gap:10px;
            margin-top:10px;padding:10px;border:1px solid var(--border);
            border-radius:9px;background:#0d0818;color:var(--text);
            font-weight:600;font-size:.92rem;text-decoration:none}
  .provider:hover{border-color:var(--accent)}
  .provider svg{width:17px;height:17px;fill:currentColor;flex:0 0 auto}
  .notyou{margin:-16px 0 22px}
  .brandhead{display:flex;flex-direction:column;align-items:center;gap:9px;margin-bottom:16px}
  .brandhead img{width:40px;height:auto}
  .brandhead .word{font-family:var(--mono);font-weight:700;letter-spacing:.1em;font-size:1.05rem}
`;

/**
 * The SOVRGN mark, inlined as a data URI because this service deliberately
 * serves no static files and must not depend on the marketing site being up
 * to render its own sign-in. Same image the site and desktop icons come from
 * (site/assets/mark-64.png), base64'd straight into the source.
 */
const MARK_DATA_URI = "data:image/png;base64,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";

/**
 * The brand header every page opens with, exported into scripts too so the
 * in-place success/refusal rewrites keep the same chrome the page loaded with.
 */
const BRAND_HTML = `<div class="brandhead"><img src="${MARK_DATA_URI}" alt=""><span class="word">SOVRGN</span></div>`;

/**
 * Provider marks for the sign-in buttons, as bare path data drawn in
 * currentColor — deliberately not the brand-color versions, so they sit in
 * the button as quietly as the label text they accompany.
 *
 * Google, GitHub, and Discord are the simple-icons 24×24 paths (CC0, vendored
 * as data because this service inlines everything it serves). Microsoft's
 * mark is four equal squares, hand-written since simple-icons dropped it. A
 * provider with no entry here renders a text-only button, which is the same
 * button this page always had.
 */
const PROVIDER_ICONS: Record<string, string> = {
  google:
    "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
  microsoft:
    "M2 2h9.5v9.5H2zM12.5 2H22v9.5h-9.5zM2 12.5h9.5V22H2zM12.5 12.5H22V22h-9.5z",
  github:
    "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  discord:
    "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
};

function shell(title: string, body: string, script = "", wide = false): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="${MARK_DATA_URI}" type="image/png">
<title>${title} — SOVRGN</title>
<style>${STYLE}</style>
</head><body><div class="card${wide ? " wide" : ""}">
${BRAND_HTML}
${body}</div>
${script ? `<script>${script}</script>` : ""}
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map(w => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** What a page needs to know about a provider: enough to draw a button. */
export type ProviderButton = { id: string; label: string };

/**
 * "Continue with …" for whichever providers the operator configured.
 *
 * Plain links, not a form: the start route does the redirect, so these work
 * with scripting disabled and there is no in-page state to lose. An empty
 * list renders nothing at all — an operator with no providers sees exactly
 * the page they had before providers existed.
 *
 * `continueTo` is the local path to resume after the round trip. It is
 * URL-encoded here and validated relative-only on the server, because a
 * continuation an attacker can point off-origin turns a successful sign-in
 * into a redirect with our chrome on it.
 */
function providerButtons(providers: ProviderButton[], continueTo: string): string {
  if (providers.length === 0) return "";
  const links = providers
    .map(p => {
      const path = PROVIDER_ICONS[p.id];
      const icon = path
        ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`
        : "";
      return `<a class="provider" href="/oauth/${escapeHtml(p.id)}/start?continue=${encodeURIComponent(continueTo)}">${icon}Sign in with ${escapeHtml(p.label)}</a>`;
    })
    .join("\n  ");
  return `
  <div class="or"><span>or</span></div>
  ${links}`;
}

/**
 * Sign in, in order to hand a token to one particular server.
 *
 * The server is named on screen because that's the whole decision being made.
 * Someone should never be signing in to "SOVRGNnet" in the abstract without
 * seeing which machine is about to learn who they are.
 */
export function signInPage(options: {
  returnUrl: string;
  instanceName: string;
  instanceHost: string;
  providers?: ProviderButton[];
  error?: string;
}): string {
  const body = `
  <h1>Sign in</h1>
  <p class="sub">to continue to this server</p>

  <div class="target">
    <div class="badge">${escapeHtml(initials(options.instanceName))}</div>
    <div>
      <strong>${escapeHtml(options.instanceName)}</strong>
      <small>${escapeHtml(options.instanceHost)}</small>
    </div>
  </div>

  ${options.error ? `<div class="err">${escapeHtml(options.error)}</div>` : ""}

  <form id="f">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit" id="go">Continue</button>
  </form>
  <div id="err"></div>
  ${providerButtons(options.providers ?? [], `/authorize?return=${encodeURIComponent(options.returnUrl)}`)}
  <p class="alt">No account? <a href="/register?return=${encodeURIComponent(options.returnUrl)}">Create one</a></p>
  <p class="note">
    This server will learn your account name and email address. It won't
    receive your password, and signing in here doesn't give it access to any
    other server.
  </p>`;

  const script = `
    const form = document.getElementById('f');
    const errBox = document.getElementById('err');
    const button = document.getElementById('go');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      errBox.innerHTML = '';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            email: document.getElementById('email').value,
            password: document.getElementById('password').value,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Sign-in failed');
        }
        // Signed in — ask again for the token, which now succeeds.
        window.location.href = ${JSON.stringify(`/authorize?return=${encodeURIComponent(options.returnUrl)}`)};
      } catch (error) {
        errBox.innerHTML = '<div class="err"></div>';
        errBox.firstChild.textContent = error.message;
        button.disabled = false;
      }
    });`;

  return shell("Sign in", body, script);
}

export function registerPage(
  options: { emailDisabled: boolean; providers?: ProviderButton[] } & (
    | {
        /** Creating an account to enter one particular server. */
        hub?: false;
        returnUrl: string;
        instanceName: string;
      }
    | {
        /**
         * Creating an account from the hub, with no server in sight yet —
         * the sign-up a marketing page can link to. Ends at /hub instead of
         * a server's /authorize, because there is no server to return to.
         */
        hub: true;
      }
  )
): string {
  const continueTo = options.hub
    ? "/hub/start"
    : `/authorize?return=${encodeURIComponent(options.returnUrl)}`;
  // Through /hub/start, not /hub directly: start is what crosses to the
  // hub's own hostname when one is configured, so a fresh account lands on
  // app.sovrgnnet.cc rather than the id host's copy of the same page.
  const afterRegister = options.hub
    ? "/recovery-codes?next=%2Fhub%2Fstart"
    : `/recovery-codes?return=${encodeURIComponent(options.returnUrl)}`;

  const body = `
  <h1>Create an account</h1>
  <p class="sub">One account, usable on any SOVRGNnet server.</p>

  <form id="f">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password"
           minlength="8" required>
    <button type="submit" id="go">Create account</button>
  </form>
  <div id="err"></div>
  ${providerButtons(options.providers ?? [], continueTo)}
  <p class="alt">Already have one? <a href="${continueTo}">Sign in</a></p>
  ${
    options.emailDisabled
      ? `<p class="note">This service doesn't send email. You'll be given recovery
         codes on the next screen — they are the only way back into your
         account if you forget your password.</p>`
      : ""
  }`;

  const script = `
    const form = document.getElementById('f');
    const errBox = document.getElementById('err');
    const button = document.getElementById('go');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      errBox.innerHTML = '';
      try {
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            email: document.getElementById('email').value,
            password: document.getElementById('password').value,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not create the account');
        // Recovery codes exist only in this response. Show them before going
        // anywhere — there is no way to fetch them again.
        sessionStorage.setItem('recoveryCodes', JSON.stringify(data.recoveryCodes || []));
        sessionStorage.setItem('recoveryWarning', data.warning || '');
        window.location.href = ${JSON.stringify(afterRegister)};
      } catch (error) {
        errBox.innerHTML = '<div class="err"></div>';
        errBox.firstChild.textContent = error.message;
        button.disabled = false;
      }
    });`;

  return shell("Create an account", body, script);
}

/**
 * Recovery codes, shown once.
 *
 * A deliberate full stop in the flow, with a checkbox: someone who clicks
 * straight past this and later forgets their password has lost the account
 * outright when email is disabled.
 */
export function recoveryCodesPage(destination: string): string {
  const body = `
  <h1>Save your recovery codes</h1>
  <p class="sub">You will not be shown these again.</p>

  <div class="codes" id="codes"></div>
  <div class="warn" id="warning"></div>

  <button id="copy" style="background:#241a3d">Copy to clipboard</button>

  <label style="display:flex;gap:9px;align-items:flex-start;margin-top:18px;cursor:pointer">
    <input type="checkbox" id="ack" style="width:auto;margin-top:4px">
    <span style="font-size:.87rem;color:var(--muted)">
      I've saved these somewhere I'll still have access to if I lose my password.
    </span>
  </label>

  <button id="go" disabled>Continue</button>`;

  const script = `
    const codes = JSON.parse(sessionStorage.getItem('recoveryCodes') || '[]');
    const warning = sessionStorage.getItem('recoveryWarning') || '';
    document.getElementById('codes').innerHTML =
      codes.map(() => '<span></span>').join('');
    document.querySelectorAll('#codes span').forEach((el, i) => { el.textContent = codes[i]; });
    document.getElementById('warning').textContent = warning;

    document.getElementById('copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(codes.join('\\n'));
      document.getElementById('copy').textContent = 'Copied';
    });

    const ack = document.getElementById('ack');
    const go = document.getElementById('go');
    ack.addEventListener('change', () => { go.disabled = !ack.checked; });
    go.addEventListener('click', () => {
      // Out of sessionStorage the moment they're no longer needed.
      sessionStorage.removeItem('recoveryCodes');
      sessionStorage.removeItem('recoveryWarning');
      window.location.href = ${JSON.stringify(destination)};
    });`;

  return shell("Recovery codes", body, script);
}

/**
 * Approving a desktop sign-in.
 *
 * The person is already signed in here; all this asks is whether the code on
 * their screen is really the one the app is showing. That question is the
 * entire security of the device flow, so it's asked plainly and the code is
 * shown large enough to compare.
 */
export function devicePage(prefilled: string, email: string): string {
  const body = `
  <h1>Connect the desktop app</h1>
  <p class="sub">Signed in as ${escapeHtml(email)}</p>
  <p class="notyou"><button type="button" id="notyou" class="linky">Not you?</button></p>

  <form id="f">
    <label for="code">${
      prefilled
        ? "Confirm this matches the code in the app"
        : "Enter the code shown in the app"
    }</label>
    <input id="code" name="code" value="${escapeHtml(prefilled)}"
           placeholder="ABCD-EFGH" autocomplete="off" spellcheck="false"
           style="text-transform:uppercase;letter-spacing:3px;text-align:center;font-size:1.1rem" required autofocus>
    <button type="submit" id="go">Connect</button>
  </form>
  <div id="err"></div>

  <p class="note">
    Only continue if you started this yourself. Approving connects that app to
    your account and the servers you've joined — if a code appeared that you
    didn't ask for, close this page.
  </p>
  <p class="alt"><button type="button" id="deny" class="linky">I didn't start this</button></p>`;

  const script = `
    const form = document.getElementById('f');
    const errBox = document.getElementById('err');
    const send = async (approve) => {
      errBox.innerHTML = '';
      try {
        const res = await fetch('/api/device/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            user_code: document.getElementById('code').value,
            approve,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'That did not work');
        document.querySelector('.card').innerHTML = ${JSON.stringify(BRAND_HTML)} + (approve
          ? '<h1>Connected</h1>' +
            '<p class="sub">You can close this page and go back to the app.</p>'
          : '<h1>Refused</h1>' +
            '<p class="sub">Nothing was connected. You can close this page.</p>');
      } catch (error) {
        errBox.innerHTML = '<div class="err"></div>';
        errBox.firstChild.textContent = error.message;
      }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); send(true); });
    document.getElementById('deny').addEventListener('click', () => send(false));
    // "Not you?" — end this session and come back to the same URL, which now
    // renders the sign-in page with the code still in it. The wrong-account
    // case would otherwise connect the app to whoever the browser happened to
    // be signed in as, with no way off the page short of visiting /api/logout
    // by hand.
    document.getElementById('notyou').addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      window.location.reload();
    });`;

  return shell("Connect the desktop app", body, script);
}

/** Sign in first, then return to approving the desktop app. */
export function deviceSignInPage(
  returnPath: string,
  code: string,
  providers: ProviderButton[] = []
): string {
  return promptSignInPage(
    returnPath,
    `to connect the desktop app${code ? ` (code ${code})` : ""}`,
    providers
  );
}

/**
 * A sign-in page that resumes a local path afterwards — the shape both the
 * device approval and the hub need, differing only in why they're asking.
 */
export function promptSignInPage(
  returnPath: string,
  subtitle: string,
  providers: ProviderButton[] = [],
  options: { registerHref?: string } = {}
): string {
  const body = `
  <h1>Sign in</h1>
  <p class="sub">${escapeHtml(subtitle)}</p>

  <form id="f">
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" required autofocus>
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password" required>
    <button type="submit" id="go">Continue</button>
  </form>
  <div id="err"></div>
  ${providerButtons(providers, returnPath)}
  ${
    options.registerHref
      ? `<p class="alt">No account? <a href="${escapeHtml(options.registerHref)}">Create one</a></p>`
      : ""
  }`;

  const script = `
    const form = document.getElementById('f');
    const errBox = document.getElementById('err');
    const button = document.getElementById('go');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      errBox.innerHTML = '';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            email: document.getElementById('email').value,
            password: document.getElementById('password').value,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Sign-in failed');
        }
        window.location.href = ${JSON.stringify(returnPath)};
      } catch (error) {
        errBox.innerHTML = '<div class="err"></div>';
        errBox.firstChild.textContent = error.message;
        button.disabled = false;
      }
    });`;

  return shell("Sign in", body, script);
}

/** What a hub server card needs: the grant, as the API would tell it. */
export type HubServer = {
  instanceId: string;
  instanceName: string | null;
  instanceUrl: string | null;
  lastUsedAt: Date;
};

/**
 * The signed-out hub: one sentence and one button.
 *
 * Deliberately a page rather than an automatic redirect to the id host —
 * signing out used to be impossible to *stay* signed out of when the hub
 * bounced straight back through a still-live id session. A person who signed
 * out sees this page and decides.
 */
export function hubLandingPage(signInUrl: string): string {
  const body = `
  <h1>Your servers, one place</h1>
  <p class="sub">Sign in with your SOVRGN account to see every server
  you're part of and jump straight into any of them.</p>
  <a class="open" style="display:block;text-align:center;background:var(--accent);color:#fff;
     padding:11px;border-radius:9px;text-decoration:none;font-weight:600"
     href="${escapeHtml(signInUrl)}">Sign in</a>
  <p class="note">One account, usable on any SOVRGNnet server — yours, a
  friend's desktop-hosted one, or any instance that trusts this identity
  service.</p>`;
  return shell("Your servers", body);
}

/**
 * The hub: every server this account has signed into, each one click away.
 *
 * The list is the grants table — an *observation log* of where this account
 * has actually been, which is why a server someone has never signed into
 * doesn't appear and why the add-a-server path exists. "Open" routes through
 * /authorize on the id host, which is the same mint every sign-in uses; the
 * hub holds no per-server credentials and never talks to a server itself.
 * The one exception runs in the visitor's own browser: adding a server reads
 * that server's public, unauthenticated descriptor to show what it is before
 * anyone signs into it.
 */
export function hubPage(options: {
  email: string;
  servers: HubServer[];
  /** The id host base URL — where /authorize and sign-out live. */
  idBase: string;
}): string {
  const { email, servers, idBase } = options;

  const cards =
    servers.length === 0
      ? `<p class="note" style="border:0;padding:0;margin-top:6px">No servers yet.
         Sign into one from its own address below, or from an invite link —
         it appears here from then on.</p>`
      : servers
          .map(s => {
            const name = s.instanceName ?? `Server ${s.instanceId.slice(0, 8)}`;
            // Only an https origin this service resolved itself may become a
            // link. instanceUrl is an observation (see schema.ts), but a
            // belt on a security surface costs one line.
            const url =
              s.instanceUrl && /^https?:\/\//.test(s.instanceUrl)
                ? s.instanceUrl
                : null;
            const open = url
              ? `<a class="open" href="${escapeHtml(
                  `${idBase}/authorize?return=${encodeURIComponent(`${url}/sso/callback`)}`
                )}">Open</a>`
              : `<span style="color:var(--muted);font-size:.8rem">address not
                 recorded yet — sign in from the server once</span>`;
            return `
  <div class="server">
    <div class="badge">${escapeHtml(initials(name))}</div>
    <div class="meta">
      <strong>${escapeHtml(name)}</strong>
      <small>${escapeHtml(url ? new URL(url).host : "—")}</small>
    </div>
    ${open}
    <button type="button" class="linky revoke" data-instance="${escapeHtml(s.instanceId)}"
            data-name="${escapeHtml(name)}">Revoke</button>
  </div>`;
          })
          .join("\n");

  const body = `
  <h1>Your servers</h1>
  <p class="sub" style="margin-bottom:4px">Signed in as ${escapeHtml(email)}</p>
  <p class="notyou"><button type="button" id="signout" class="linky">Sign out</button></p>

  ${cards}
  <div id="err"></div>

  <div class="or"><span>add a server</span></div>
  <form class="addrow" id="add">
    <input id="addr" placeholder="chat.example.com" autocomplete="off"
           spellcheck="false" autocapitalize="none">
    <button type="submit">Find</button>
  </form>
  <div id="found"></div>

  <p class="note">
    Opening a server signs you in over there with this account. Revoking
    stops new sign-ins to that server; the account it already created for
    you lives on that server and is removed there, not here.
  </p>`;

  // The add-a-server probe runs in the *visitor's* browser against the
  // server's public descriptor (CORS-open by design over there). This page
  // deliberately never proxies it: the identity service resolving arbitrary
  // typed-in addresses server-side would be an SSRF surface.
  const script = `
    const err = document.getElementById('err');
    const showErr = (m) => { err.innerHTML = '<div class="err"></div>'; err.firstChild.textContent = m; };

    // Both sessions, not one. Ending only this host's session left the id
    // host's alive, so 'Sign in' walked straight back into the account that
    // was just signed out of — a sign-out that didn't mean it. The id host
    // ends its own session and sends them back here, landing page, actually
    // signed out.
    document.getElementById('signout').addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      window.location.href = ${JSON.stringify(idBase)} + '/hub/signout';
    });

    document.querySelectorAll('.revoke').forEach((el) => {
      el.addEventListener('click', async () => {
        if (!confirm('Stop new sign-ins to ' + el.dataset.name + '? Your account there stays until you remove it there.')) return;
        const res = await fetch('/api/grants/' + encodeURIComponent(el.dataset.instance) + '/revoke', {
          method: 'POST', credentials: 'same-origin',
        });
        if (!res.ok) { showErr('Could not revoke that right now.'); return; }
        window.location.reload();
      });
    });

    const found = document.getElementById('found');
    document.getElementById('add').addEventListener('submit', async (e) => {
      e.preventDefault();
      err.innerHTML = ''; found.innerHTML = '';
      let addr = document.getElementById('addr').value.trim();
      if (!addr) return;
      if (!/^https?:\\/\\//.test(addr)) addr = 'https://' + addr;
      let origin;
      try { origin = new URL(addr).origin; } catch { showErr('That does not look like an address.'); return; }
      let info;
      try {
        const res = await fetch(origin + '/api/instance', { signal: AbortSignal.timeout(6000) });
        info = await res.json();
      } catch { showErr('No SOVRGNnet server answered at ' + origin + '.'); return; }
      if (!info || info.product !== 'sovrgnnet') { showErr('Something answered at ' + origin + ', but it is not a SOVRGNnet server.'); return; }
      if (info.identityIssuer && info.identityIssuer !== ${JSON.stringify(idBase)}) {
        showErr('That server trusts a different identity service, so this account cannot sign in there.');
        return;
      }
      const div = document.createElement('div');
      div.className = 'server';
      const badge = document.createElement('div'); badge.className = 'badge';
      badge.textContent = (info.name || '?').split(/\\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
      const meta = document.createElement('div'); meta.className = 'meta';
      const strong = document.createElement('strong'); strong.textContent = info.name || origin;
      const small = document.createElement('small'); small.textContent = new URL(origin).host;
      meta.append(strong, small);
      const a = document.createElement('a'); a.className = 'open'; a.textContent = 'Sign in';
      a.href = ${JSON.stringify(idBase)} + '/authorize?return=' + encodeURIComponent(origin + '/sso/callback');
      div.append(badge, meta, a);
      found.append(div);
    });`;

  return shell("Your servers", body, script, true);
}

export function errorPage(title: string, message: string): string {
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1>
     <p class="sub">${escapeHtml(message)}</p>`
  );
}
