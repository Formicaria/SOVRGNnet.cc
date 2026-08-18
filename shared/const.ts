/**
 * Advertised by GET /api/instance so clients can reason about compatibility.
 * Keep in step with package.json — `pnpm test` fails if these drift.
 */
export const APP_VERSION = "0.6.2";

/**
 * Custom scheme the desktop client registers, so an invite link can hand off
 * from a browser to the app: sovrgn://invite/<host>/<code>
 */
export const APP_URL_SCHEME = "sovrgn";

export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';
