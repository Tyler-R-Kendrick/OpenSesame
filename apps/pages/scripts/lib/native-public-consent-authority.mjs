/** Disclosed HTTP protocol authority. It changes upstream replies, never app state. */
import { createHash } from "node:crypto";

export function consentDocument(url, callback, code) {
  const target = new URL(callback);
  target.searchParams.set("code", code);
  target.searchParams.set("state", url.searchParams.get("state"));
  return `<!doctype html><html><head><title>Disclosed protocol test consent</title></head><body><h1>Protocol test consent</h1><p>Synthetic upstream authority; no live account.</p><p>Public client with S256 PKCE.</p><a href="${target.href.replaceAll("&", "&amp;")}">Approve protocol test consent</a></body></html>`;
}

export function assertPublicConsent(url, callback, check) {
  check(
    url.searchParams.get("redirect_uri") === callback,
    "consent binds the actual deployed callback bridge",
  );
  check(
    url.searchParams.get("response_type") === "code",
    "consent requests authorization code",
  );
  check(
    url.searchParams.get("code_challenge_method") === "S256",
    "consent uses S256 PKCE",
  );
  check(
    Boolean(url.searchParams.get("state")),
    "consent has a sealed transaction state",
  );
  check(
    !url.searchParams.has("client_secret"),
    "public consent never contains a client secret",
  );
}

export function assertPublicExchange(form, consent, callback, check) {
  check(
    form.get("grant_type") === "authorization_code",
    "token request exchanges the actual authorization code",
  );
  check(
    form.get("redirect_uri") === callback,
    "token request pins the deployed callback",
  );
  check(
    !form.has("client_secret"),
    "browser token request has no confidential client secret",
  );
  const challenge = createHash("sha256")
    .update(form.get("code_verifier") ?? "")
    .digest("base64url");
  check(
    challenge === consent.searchParams.get("code_challenge"),
    "token verifier matches the observed S256 consent challenge",
  );
  check(
    form.get("client_id") === consent.searchParams.get("client_id"),
    "token exchange retains the exact consent client",
  );
}

export function publicAuthorityReply(route, body, status = 200) {
  const reply = {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization,content-type,mcp-protocol-version,mcp-session-id",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    },
  };
  if (status !== 204) reply.body = body === null ? "" : JSON.stringify(body);
  return route.fulfill(reply);
}
