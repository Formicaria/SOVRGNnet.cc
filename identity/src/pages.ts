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
  .linky{background:none;border:0;color:var(--muted);font-size:.85rem;cursor:pointer;text-decoration:underline;padding:0}
  .linky:hover{color:var(--text)}
  .warn{margin-top:14px;padding:11px 13px;border-radius:8px;font-size:.85rem;
        background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);color:var(--warn)}
  .or{display:flex;align-items:center;gap:10px;margin:18px 0 4px;color:var(--muted);font-size:.78rem}
  .or::before,.or::after{content:"";flex:1;height:1px;background:var(--border)}
  .provider{display:block;margin-top:10px;padding:10px;border:1px solid var(--border);
            border-radius:9px;background:#0d0818;color:var(--text);text-align:center;
            font-weight:600;font-size:.92rem;text-decoration:none}
  .provider:hover{border-color:var(--accent)}
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
const MARK_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAABACAMAAACAyb93AAABgFBMVEWWG+WVIuigXNzhT/uiE+blWvGYJe3cZPv/mvZaB6nWKfzULv1bEKZuD9x3BtzlTvv/0f1iArF9JOnEN/vLNv0AAKp/P7+/L7+SSr35nvs+AMJyA+F/f39/f/+IELCPP7+mQt3/p////1UAAAAzAY5IA7JTA81tBfIpAW//AP86AaeMF/p/AP+SJfarKPyyNvsAAP9+AL3WVvqGCPz/fv1GBZLLR/urAP/yd/w/AL9aAeTJN/vsZ/puGNKoF/3///8bAFZVAKp2JNC/P//JKvz3lf75qPx/AH9yB9JtB9BnCNTJZ/YdAGljB8f7Ov/oV/sAAH9VF65nGrZqJauMDOiHKNSqAKqsGPeqVf+zWO/ORfvxhfw/AH9OGJJdE8qJBdWRFPWSSNL3aPcAAFV5CNh2EvWMFu+PFvGzOPCxR/TPOfrVU/LXhvz1F///Vf/pWPv/tf8jA1xVAP9wCqxnCrRzGst0GdB6NK+QCeqWFPuXOtGvJPyqOO60M/qrU9rIK/bLkEW7AAAAgHRSTlNnl/xeJhzp8RGlG+Te312c/VccXokDBAb+nf2KAgKI/Rd6AwD8/Pz7/AH8/AL8/PwBBPz8Bfz7A/0E/Pn9+fwD+wP9BPj9/QKOrfb9/M0J+wL89/tO/AMvA/0x/QT9/TCx/RMDZvxxj1L8sDD9CwMx/P0DyO611v0x1vXQNKn2J0Miv+UAAAXRSURBVHjalZdnQ9tIEIZlY5seUi/J9bvZImmtglwwrmDAFNNLCL0EEggkkJ5L/es3u5I5wDZH9osx0qPVzLzzzlqDZqvU9IrW7EIckj/KDEIbJI0fYdx1uPXtL0iWrs8YT0BLPag8hMbvpzUMBX5P6eHTkYcleHk95hHstqdSJHwzn2ltg6HrML0w/SZFqGTS6YaQVo98lwhlx8g4TjpaD2l1SORtiiLiVCuZtGNZTgvEjasYox+0t5Qxxp0YszJpyxLCagHXaM4YLmgTCHBxWGaUznmOEPtchC7l/DyDT3vGs5xze2WOmJTqeszmcn0twePGzGNIbqtbcogQzJyu658klOWxJPzUiBmC6D8JLvaFt0JxE58hZYtzjO/9CdyuZ4agQyLCzh8ymQU2RYlcCDGMrbCKKb3IuHG4U0wkhJXLhPF+DOop3JjAe6lZQIgSs3AA68Z5xlCIsGxvLSbzxhMa9MOWfCvKClbWlPFpKks1BjN5VyJOfq1bIf98QaFiebsVtWkxBYWUfH3mMZS+Colkjvclktj+U13sg/shnpVbWZxgRsi7NhSwYgyIfsbo7dxalSnk2d94e9AUIZU22j2B0CTpmpavp4Hx69Fn3MPLVDyUGZPRu/FalV/DIu5ETbMgGE0R0hUxDGTiydD8woc/vrV6jBCT8RvQ56oSu/5WHydkMMTJOFZ5bi5UGkXGNXrb9YEBnQlT183u236c8h2MAJqSsVgznJm0PTrqynhcKI2htlICr7RH/NKhWo9KPt0HL8apTgrpLOMh8OMBGMUPqqcKiBhoUkHyc9tJPxVIjtHJeTsrNJg1avUx7sEiTVFyS/GAxtH23E7z7WiwqbShDSFa4LVxTjtYdEpvwbrrS2+303aqmOHvQXD9cPvtcEvw5UyjvbC1Bevqz2k4ydmWt8YInVgO7kOXODozBu2cqanLmP8WRJzMCKaJTmjQG+QcjPr+iSvkN1ci6DeVimQoVnjQz3myme8YkOwZtp30zEhlp6D6iD+DWhxNfMc46kkfepmR0+NNohe47KQEpq/vCiYOX+Y3Nja6FpYETQ3oZeUoiVgH3L/CE0dhq0uXPkALBPW0JKSnJD6vXjBTrc7gO96kJEPpwCtdX7ITgieKw1GsQAMm7sv5EUyPo3tg/GQANyznikKIIhZ0up6Jw5mQIcSIbDQULvqOl7PRKBAaMi4xfdARavPd0pgFjVGM42k79o1Zzrfatl3sbIG+0gUmDqtCvNv13dIYhD0Wi62CMYbWaG5WZ3K53Ey+B9zkOSYOLSKxRN6vBm7ZC9rzNojMwi/ScWg147XmZzp7Sr7Xa37X3xHc/kTI/EFQ80H1uu4g3GCyscMj+fzM8DA+56XPuMpdEl4YL7KDmrwM+eH2ww3p22SlsjYzXCx2JgPfie+GhHC8StXEhUK+IC+EpNfrOzdPM62YiRO0XA1zdWCh8Tz4diikP7NQSRkf1Ex5Wdo1YTs7Ox8WumIavrJ67B6dRKGQspBWRt8lzzSZRJMR0hWtBR29aRK7f7TmIZoaNvq8HAEmfV+bGy+hdBdlwEV6YfIVKim1WPNemdrlKUVt+FAhgnEoX3iOGsBY5yalbruW1b+D+vRCB3oYrpScUKbJNHhiDMFJp40t61XV88zxFz5S00EfTI8F0H4W6yiHDTa5g02eWVHeS8f8qp3TW1z6ohqGS0LmibZ39KRxeSMrP6vhswezo5d1jSJbVKMJ0ych8inveV5+JCyrZtLFwPsu9ZzMhIIKcq5NhjMeGkPZJIh0R4JQ6voUh+GU6hk1DFFja8eb+BCTjnf8N7Qv97Y/AnDRpQkzfFppZZeib+w74KeP2jx8s+oje/40aOohcgTIalAuWr0ElYNvEfrd/znz9UMEIcK504kMnVq+EErTs2UEhyHl9jBKYjxajzQ6w6pMEO7Y2QZefcVZeQwPl0WuwT3j2mdy6VaO/aXRJs1/L/TDx6/RJsgVvzGgGQL/AkTXFtVOT2ZuAAAAAElFTkSuQmCC";

/**
 * The brand header every page opens with, exported into scripts too so the
 * in-place success/refusal rewrites keep the same chrome the page loaded with.
 */
const BRAND_HTML = `<div class="brandhead"><img src="${MARK_DATA_URI}" alt=""><span class="word">SOVRGN</span></div>`;

function shell(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — SOVRGN</title>
<style>${STYLE}</style>
</head><body><div class="card">
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
    .map(
      p =>
        `<a class="provider" href="/oauth/${escapeHtml(p.id)}/start?continue=${encodeURIComponent(continueTo)}">Continue with ${escapeHtml(p.label)}</a>`
    )
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

export function registerPage(options: {
  returnUrl: string;
  instanceName: string;
  emailDisabled: boolean;
  providers?: ProviderButton[];
}): string {
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
  ${providerButtons(options.providers ?? [], `/authorize?return=${encodeURIComponent(options.returnUrl)}`)}
  <p class="alt">Already have one? <a href="/authorize?return=${encodeURIComponent(options.returnUrl)}">Sign in</a></p>
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
        window.location.href = ${JSON.stringify(`/recovery-codes?return=${encodeURIComponent(options.returnUrl)}`)};
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
export function recoveryCodesPage(returnUrl: string): string {
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
      window.location.href = ${JSON.stringify(`/authorize?return=${encodeURIComponent(returnUrl)}`)};
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
  <p class="sub">Signed in as ${escapeHtml(email)} ·
    <button type="button" id="notyou" class="linky">Not you?</button></p>

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
  const body = `
  <h1>Sign in</h1>
  <p class="sub">to connect the desktop app${code ? ` (code ${escapeHtml(code)})` : ""}</p>

  <form id="f">
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" required autofocus>
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password" required>
    <button type="submit" id="go">Continue</button>
  </form>
  <div id="err"></div>
  ${providerButtons(providers, returnPath)}`;

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

export function errorPage(title: string, message: string): string {
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1>
     <p class="sub">${escapeHtml(message)}</p>`
  );
}
