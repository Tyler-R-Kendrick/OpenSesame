/**
 * Parameter names that must never appear in an interaction link (ADR 0086).
 *
 * This lives in its own browser-safe module rather than beside the reference
 * MAC, and the reason is worth stating because getting it wrong is silent.
 * `crypto/interaction-ref.ts` imports `node:crypto`, so it is reachable only
 * from the Node entry; `apps/pages` aliases `@opensesame/os-domain` straight
 * to `browser.ts`. A deny-list that resolved to `undefined` in a browser
 * bundle would not fail loudly — it would read as an empty list, and an empty
 * deny-list means *nothing is forbidden*. The one guard standing between a
 * link builder and a bearer in a URL would quietly stop guarding on exactly
 * the surface with the most link builders.
 *
 * So the list has no crypto dependency and is exported from both entries.
 *
 * Deny-first: a name that looks like credential material is refused even if
 * some future caller had a benign reason for it. The cost of a false refusal
 * is a rename; the cost of a false pass is a token in someone's browser
 * history, server logs, and `Referer` headers.
 */
export const FORBIDDEN_URL_PARAMS: readonly string[] = [
  "access_token",
  "id_token",
  "refresh_token",
  "token",
  "bearer",
  "authorization",
  "code",
  "device_code",
  "client_secret",
  "secret",
  "secret_ref",
  "password",
  "passphrase",
  "claim_token",
  "session",
  "session_token",
  "sid",
  "api_key",
  "apikey",
  "credential",
  "vp_token",
  "presentation",
  "assertion",
  "pan",
  "cvv",
  "card_number",
];
