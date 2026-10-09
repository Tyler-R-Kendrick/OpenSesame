import { isLoopbackOrigin } from "@opensesame/static-auth";
import { env, staticAuthRelease } from "../host.js";
import { page, pageOrigin } from "../ports.js";
/**
 * Origin-brokered sign-in for static relying parties (ADR 0034).
 *
 * This deployment cannot mint tokens. It relays an upstream id_token to an RP
 * origin the human has approved, via postMessage — never "*".
 * Wire contract: docs/architecture/federated-signin.md §2–§5.
 */

import type { UpstreamIdentity } from "./federation.js";
import { originClientId } from "./federation-origin.js";
import { kvDelete, kvGet, kvSet } from "./kv.js";
import { scopedKey } from "./projects.js";
import {
  type BrokerPolicy,
  CONSENTS_KEY,
  type DomainEffect,
  type DomainRule,
  POLICY_KEY,
  type SiteConsent,
  normalizeDomainEntry,
  parseBrokerPolicy,
  parseConsents,
  sortRules,
} from "./site-broker-records.js";

export {
  type BrokerPolicy,
  CONSENTS_KEY,
  type DomainEffect,
  type DomainRule,
  POLICY_KEY,
  type SiteConsent,
  normalizeDomainEntry,
  parseBrokerPolicy,
  parseConsents,
} from "./site-broker-records.js";

export type BrokerRequest = {
  clientId: string;
  /** Exact RP origin (scheme + host [+ port]). */
  origin: string;
  state: string;
  scope: string;
};

export type BrokerAuthorizeParams = {
  origin: string;
  state: string;
  scope?: string;
};

export type SignInSuccess = {
  type: "opensesame:signin";
  state: string;
  id_token: string;
  issuer: string;
  audience: string;
  jwks_uri: string;
  expires_at: string;
};

export type SignInError = {
  type: "opensesame:signin";
  state: string;
  error: string;
  error_description?: string;
};

export type SignInMessage = SignInSuccess | SignInError;

export type DeliverToRpOptions = {
  redirectUri?: string | null;
  close?: boolean;
};

const MIN_STATE_BYTES = 16;

export function pagesPublicBase(origin: string = pageOrigin()): string {
  const base = env().BASE_URL || "/";
  const normalised = base.endsWith("/") ? base : `${base}/`;
  return `${origin}${normalised}`;
}

export function brokerAuthorizePath(): string {
  return "broker/authorize";
}

export function brokerAuthorizeUrl(
  params: BrokerAuthorizeParams,
  base: string = pagesPublicBase(),
): string {
  const url = new URL(brokerAuthorizePath(), base);
  url.searchParams.set("client_id", `origin:${params.origin}`);
  url.searchParams.set("origin", params.origin);
  url.searchParams.set("state", params.state);
  url.searchParams.set("scope", params.scope ?? "openid");
  url.searchParams.set("profile", "pages_passthrough_loopback");
  return url.toString();
}

export function scriptTagSrc(base: string = pagesPublicBase()): string {
  return new URL(
    `static-auth/${staticAuthRelease().version}/opensesame-auth.min.js`,
    base,
  ).toString();
}

/**
 * Parse and validate the broker query. Does not consult window.opener — the
 * message is addressed only to `origin`, so a forged origin cannot deliver
 * the token to the forger's window.
 */
export function parseBrokerRequest(
  search: string,
):
  | { ok: true; request: BrokerRequest }
  | { ok: false; error: string; detail: string } {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const clientId = params.get("client_id")?.trim() ?? "";
  const origin = params.get("origin")?.trim() ?? "";
  const state = params.get("state")?.trim() ?? "";
  const scope = (params.get("scope")?.trim() || "openid").replace(/\s+/g, " ");

  if (!origin || !clientId || !state) {
    return {
      ok: false,
      error: "invalid_request",
      detail: "client_id, origin, and state are required.",
    };
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return {
      ok: false,
      error: "invalid_request",
      detail: "origin must be an absolute URL origin.",
    };
  }
  if (parsedOrigin.origin !== origin) {
    return {
      ok: false,
      error: "invalid_request",
      detail: "origin must be exactly scheme://host[:port] with no path.",
    };
  }

  if (
    params.get("profile") !== "pages_passthrough_loopback" ||
    !isLoopbackOrigin(origin)
  ) {
    return {
      ok: false,
      error: "unsupported_profile",
      detail:
        "Token passthrough requires the explicit loopback development profile. Remote sites use hosted Identity with PKCE.",
    };
  }

  const expected = `origin:${origin}`;
  if (clientId !== expected) {
    return {
      ok: false,
      error: "origin_mismatch",
      detail: `client_id must be ${expected}.`,
    };
  }

  // ≥16 bytes of entropy once base64url-decoded, or ≥22 chars of opaque text.
  if (state.length < 22 && !looksLikeEnoughEntropy(state)) {
    return {
      ok: false,
      error: "invalid_request",
      detail: "state must carry at least 16 bytes of entropy.",
    };
  }

  return {
    ok: true,
    request: { clientId, origin, state, scope },
  };
}

function looksLikeEnoughEntropy(state: string): boolean {
  try {
    const padded = state.replace(/-/g, "+").replace(/_/g, "/");
    const pad =
      padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const binary = atob(padded + pad);
    return binary.length >= MIN_STATE_BYTES;
  } catch {
    return false;
  }
}

export function scopeList(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean);
}

export function loadConsents(): SiteConsent[] {
  return parseConsents(kvGet(scopedKey(CONSENTS_KEY)));
}

function saveConsents(consents: SiteConsent[]): void {
  kvSet(scopedKey(CONSENTS_KEY), JSON.stringify({ consents }));
}

export function consentFor(origin: string): SiteConsent | null {
  return loadConsents().find((c) => c.origin === origin) ?? null;
}

/** True when prior consent covers every requested scope. */
export function consentCovers(
  consent: SiteConsent | null,
  scope: string,
): boolean {
  if (!consent) return false;
  const needed = new Set(scopeList(scope));
  const have = new Set(consent.scopes);
  for (const s of needed) {
    if (!have.has(s)) return false;
  }
  return true;
}

export function approveConsent(origin: string, scope: string): SiteConsent {
  const scopes = scopeList(scope);
  const now = new Date().toISOString();
  const existing = loadConsents();
  const next: SiteConsent = {
    origin,
    scopes: Array.from(
      new Set([...(consentFor(origin)?.scopes ?? []), ...scopes]),
    ),
    approvedAt: consentFor(origin)?.approvedAt ?? now,
    lastUsedAt: now,
  };
  const without = existing.filter((c) => c.origin !== origin);
  saveConsents(
    [...without, next].sort((a, b) => a.origin.localeCompare(b.origin)),
  );
  return next;
}

export function touchConsent(origin: string): void {
  const existing = loadConsents();
  const hit = existing.find((c) => c.origin === origin);
  if (!hit) return;
  hit.lastUsedAt = new Date().toISOString();
  saveConsents(existing);
}

export function revokeConsent(origin: string): void {
  const next = loadConsents().filter((c) => c.origin !== origin);
  if (next.length === 0) kvDelete(scopedKey(CONSENTS_KEY));
  else saveConsents(next);
}

export function loadBrokerPolicy(): BrokerPolicy {
  return parseBrokerPolicy(kvGet(scopedKey(POLICY_KEY)));
}

function saveBrokerPolicy(policy: BrokerPolicy): void {
  kvSet(
    scopedKey(POLICY_KEY),
    JSON.stringify({ rules: sortRules(policy.rules) }),
  );
}

/** Whether an RP origin matches a single domain list entry. */
export function originMatchesDomainEntry(
  origin: string,
  entry: string,
): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const hostPort = `${host}${url.port ? `:${url.port}` : ""}`;
  const normalised = normalizeDomainEntry(entry);
  if (!normalised) return false;

  if (normalised.includes("://")) {
    return url.origin.toLowerCase() === normalised;
  }

  if (normalised.includes(":")) {
    return hostPort === normalised;
  }

  return host === normalised || host.endsWith(`.${normalised}`);
}

/** Higher score = more specific match (exact origin beats bare host). */
export function domainMatchScore(origin: string, entry: string): number {
  if (!originMatchesDomainEntry(origin, entry)) return 0;
  const normalised = normalizeDomainEntry(entry);
  if (!normalised) return 0;
  if (normalised.includes("://")) return 1000 + normalised.length;
  if (normalised.includes(":")) return 500 + normalised.length;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === normalised) return 100 + normalised.length;
  } catch {
    /* ignore */
  }
  return 50 + normalised.length;
}

function bestMatchingRule(
  origin: string,
  rules: DomainRule[],
): DomainRule | null {
  let best: DomainRule | null = null;
  let bestScore = 0;
  for (const rule of rules) {
    const score = domainMatchScore(origin, rule.domain);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

export function addDomainRule(
  raw: string,
  effect: DomainEffect = "whitelist",
): BrokerPolicy | { error: string } {
  const domain = normalizeDomainEntry(raw);
  if (!domain) {
    return {
      error:
        "Enter a hostname (example.com), host:port (localhost:5173), or origin (https://app.example.com).",
    };
  }
  const current = loadBrokerPolicy();
  const without = current.rules.filter((r) => r.domain !== domain);
  const next: BrokerPolicy = {
    rules: sortRules([...without, { domain, effect }]),
  };
  saveBrokerPolicy(next);
  return next;
}

export function setDomainRuleEffect(
  domain: string,
  effect: DomainEffect,
): BrokerPolicy {
  const current = loadBrokerPolicy();
  const target = normalizeDomainEntry(domain) ?? domain.toLowerCase();
  const next: BrokerPolicy = {
    rules: sortRules(
      current.rules.map((r) => (r.domain === target ? { ...r, effect } : r)),
    ),
  };
  saveBrokerPolicy(next);
  return next;
}

export function removeDomainRule(domain: string): BrokerPolicy {
  const current = loadBrokerPolicy();
  const target = normalizeDomainEntry(domain) ?? domain.toLowerCase();
  const next: BrokerPolicy = {
    rules: current.rules.filter((r) => r.domain !== target),
  };
  saveBrokerPolicy(next);
  return next;
}

/**
 * Domain gate before consent:
 * - Best matching blacklist → refuse
 * - Best matching whitelist → allow
 * - No match, but any whitelist exists → refuse (closed / restricted)
 * - No match, no whitelists → allow loopback only.
 * Domain rules may narrow admission, never enable remote passthrough.
 */
export function originMayUseBroker(origin: string): boolean {
  if (!isLoopbackOrigin(origin)) return false;
  const { rules } = loadBrokerPolicy();
  const best = bestMatchingRule(origin, rules);
  if (best?.effect === "blacklist") return false;
  if (best?.effect === "whitelist") return true;
  return !isBrokerRestricted({ rules });
}

/** True when at least one allow-list domain exists (closed world). */
export function isBrokerRestricted(
  policy: BrokerPolicy = loadBrokerPolicy(),
): boolean {
  return policy.rules.some((r) => r.effect === "whitelist");
}

export function domainFilterDenialMessage(
  origin: string,
  policy: BrokerPolicy = loadBrokerPolicy(),
): string {
  const best = bestMatchingRule(origin, policy.rules);
  if (best?.effect === "blacklist") {
    return `This origin matches a blocked domain (${best.domain}).`;
  }
  return "This origin is not on the allow list. Passthrough is restricted to loopback development sites; remote sites use hosted Identity with PKCE.";
}

export function buildSuccessMessage(
  request: BrokerRequest,
  identity: UpstreamIdentity,
): SignInSuccess {
  if (!originMayUseBroker(request.origin)) throw new Error("loopback_only");
  return {
    type: "opensesame:signin",
    state: request.state,
    id_token: identity.idToken,
    issuer: identity.issuer,
    audience: identity.audience || originClientId(),
    jwks_uri: identity.jwksUri,
    expires_at: new Date(identity.expiresAt).toISOString(),
  };
}

export function buildErrorMessage(
  state: string,
  error: string,
  detail?: string,
): SignInError {
  return {
    type: "opensesame:signin",
    state,
    error,
    ...(detail ? { error_description: detail } : undefined),
  };
}

/**
 * Deliver only to a loopback opener. Never transport tokens through a URL.
 */
function deliverToRpDefault(
  message: SignInMessage,
  targetOrigin: string,
  options: DeliverToRpOptions = {},
): "postMessage" | "none" {
  if (!isLoopbackOrigin(targetOrigin)) return "none";
  const close = options.close !== false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return postToOpener(message, targetOrigin, close)
        ? "postMessage"
        : "none";
    } catch {
      /* cross-origin opener access can throw once; postMessage itself is fine */
    }
  }
  return "none";
}

function postToOpener(message: SignInMessage, to: string, close: boolean) {
  const opener = page().opener;
  if (!opener || opener.closed) return false;
  opener.postMessage(message, to);
  if (close) page().close();
  return true;
}

export const siteBrokerSeams = {
  deliverToRp: deliverToRpDefault,
};

export function deliverToRp(
  message: SignInMessage,
  targetOrigin: string,
  options: DeliverToRpOptions = {},
): "postMessage" | "none" {
  return siteBrokerSeams.deliverToRp(message, targetOrigin, options);
}

/** Remote RPs must supply their own hosted Identity configuration. */
export function staticSiteSnippet(opts: {
  brokerBase: string;
  siteOrigin: string;
}): string {
  const script = scriptTagSrc(opts.brokerBase);
  const config = isLoopbackOrigin(opts.siteOrigin)
    ? JSON.stringify({
        profile: "pages_passthrough_loopback",
        brokerBase: opts.brokerBase,
        issuer: "https://shoo.dev",
        audience: `origin:${new URL(opts.brokerBase).origin}`,
      }).replace(/</g, "\\u003c")
    : 'await fetch("/opensesame-auth-profile.json", { credentials: "omit", redirect: "error" }).then(response => { if (!response.ok) throw new Error("profile_unavailable"); return response.json(); })';
  return `<!-- Hosted Identity + PKCE is required for remote sites. Self-hosting this SDK is supported. -->
<script src="${script.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}" integrity="${staticAuthRelease().sri}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<button type="button" id="opensesame-signin">Sign in</button>
<script type="module">
  const profile = ${config};
  document.getElementById("opensesame-signin").addEventListener("click", () => OpenSesame.signIn(profile));
  if (profile.profile === "hosted_identity") await OpenSesame.complete(profile);
  // signed_in contains only a validated subject and expiry; never log credentials.
</script>`;
}

/** Power-user snippet — explicit OpenSesame.signIn / acceptSession control. */
export function staticSiteExplicitSnippet(opts: {
  brokerBase: string;
  siteOrigin: string;
}): string {
  return staticSiteSnippet(opts);
}
