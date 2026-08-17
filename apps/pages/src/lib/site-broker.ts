/**
 * Origin-brokered sign-in for static relying parties (ADR 0034).
 *
 * This deployment cannot mint tokens. It relays an upstream id_token to an RP
 * origin the human has approved, via postMessage — never "*".
 * Wire contract: docs/architecture/federated-signin.md §2–§5.
 */

import type { UpstreamIdentity } from "./federation.js";
import { originClientId } from "./federation.js";
import { kvDelete, kvGet, kvSet } from "./kv.js";

export const CONSENTS_KEY = "site-broker.consents.v1";
export const POLICY_KEY = "site-broker.policy.v1";

/** Per-domain rule: whitelist allows, blacklist refuses. */
export type DomainEffect = "whitelist" | "blacklist";

export type DomainRule = {
  domain: string;
  effect: DomainEffect;
};

export type BrokerPolicy = {
  rules: DomainRule[];
};

const DEFAULT_POLICY: BrokerPolicy = { rules: [] };

export type BrokerRequest = {
  clientId: string;
  /** Exact RP origin (scheme + host [+ port]). */
  origin: string;
  state: string;
  scope: string;
};

export type SiteConsent = {
  origin: string;
  scopes: string[];
  approvedAt: string;
  lastUsedAt: string;
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

const MIN_STATE_BYTES = 16;

export function pagesPublicBase(origin: string = location.origin): string {
  const base = import.meta.env.BASE_URL || "/";
  const normalised = base.endsWith("/") ? base : `${base}/`;
  return `${origin}${normalised}`;
}

export function brokerAuthorizePath(): string {
  return "broker/authorize";
}

export function brokerAuthorizeUrl(
  params: { origin: string; state: string; scope?: string },
  base: string = pagesPublicBase(),
): string {
  const url = new URL(brokerAuthorizePath(), base);
  url.searchParams.set("client_id", `origin:${params.origin}`);
  url.searchParams.set("origin", params.origin);
  url.searchParams.set("state", params.state);
  url.searchParams.set("scope", params.scope ?? "openid");
  return url.toString();
}

export function scriptTagSrc(base: string = pagesPublicBase()): string {
  return new URL("auth.js", base).toString();
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
  const raw = kvGet(CONSENTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { consents?: SiteConsent[] };
    return Array.isArray(parsed.consents) ? parsed.consents : [];
  } catch {
    return [];
  }
}

function saveConsents(consents: SiteConsent[]): void {
  kvSet(CONSENTS_KEY, JSON.stringify({ consents }));
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
  if (next.length === 0) kvDelete(CONSENTS_KEY);
  else saveConsents(next);
}

export function loadBrokerPolicy(): BrokerPolicy {
  const raw = kvGet(POLICY_KEY);
  if (!raw) return { rules: [] };
  try {
    const parsed = JSON.parse(raw) as {
      rules?: unknown;
      listMode?: string;
      domains?: unknown;
    };

    if (Array.isArray(parsed.rules)) {
      const rules = parsed.rules
        .map((row) => normalizeRule(row))
        .filter((row): row is DomainRule => row !== null);
      return { rules: sortRules(rules) };
    }

    // Migrate global listMode + domains[] → per-row whitelist/blacklist.
    if (Array.isArray(parsed.domains)) {
      const effect: DomainEffect =
        parsed.listMode === "allowlist" ? "whitelist" : "blacklist";
      const rules = parsed.domains
        .filter((d): d is string => typeof d === "string")
        .map((d) => normalizeDomainEntry(d))
        .filter((d): d is string => d !== null)
        .map((domain) => ({ domain, effect }));
      return { rules: sortRules(rules) };
    }

    return { rules: [] };
  } catch {
    return { rules: [] };
  }
}

function normalizeRule(row: unknown): DomainRule | null {
  if (!row || typeof row !== "object") return null;
  const domainRaw = (row as { domain?: unknown }).domain;
  const effectRaw = (row as { effect?: unknown }).effect;
  if (typeof domainRaw !== "string") return null;
  const domain = normalizeDomainEntry(domainRaw);
  if (!domain) return null;
  const effect: DomainEffect =
    effectRaw === "blacklist" ? "blacklist" : "whitelist";
  return { domain, effect };
}

function sortRules(rules: DomainRule[]): DomainRule[] {
  return [...rules].sort((a, b) => a.domain.localeCompare(b.domain));
}

function saveBrokerPolicy(policy: BrokerPolicy): void {
  kvSet(POLICY_KEY, JSON.stringify({ rules: sortRules(policy.rules) }));
}

/**
 * Normalise a domain list entry. Accepts origin URLs, host:port, or bare host.
 * Returns null when the input cannot be a useful match key.
 */
export function normalizeDomainEntry(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed.includes("://")) {
    try {
      const url = new URL(trimmed);
      if (url.pathname !== "/" && url.pathname !== "") return null;
      if (url.search || url.hash) return null;
      return url.origin.toLowerCase();
    } catch {
      return null;
    }
  }

  if (trimmed.includes("/") || trimmed.includes("?") || trimmed.includes("#")) {
    return null;
  }
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) return null;
  return trimmed;
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
 * - No match, no whitelists → allow (public / open)
 *
 * Public until the first allowed (whitelist) domain is added. Optional blocked
 * domains apply in both modes.
 */
export function originMayUseBroker(origin: string): boolean {
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
  return "This origin is not on the allow list. Add it under Sites → Domain access, or remove every allowed domain to make the broker public again.";
}

export function buildSuccessMessage(
  request: BrokerRequest,
  identity: UpstreamIdentity,
): SignInSuccess {
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
    ...(detail ? { error_description: detail } : {}),
  };
}

/**
 * Deliver to the RP origin only. Prefer postMessage to opener; fall back to
 * fragment redirect when the RP provided redirect_uri and opener is gone.
 */
export function deliverToRp(
  message: SignInMessage,
  targetOrigin: string,
  options: { redirectUri?: string | null; close?: boolean } = {},
): "postMessage" | "fragment" | "none" {
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(message, targetOrigin);
      if (options.close !== false) {
        window.close();
      }
      return "postMessage";
    }
  } catch {
    /* cross-origin opener access can throw; postMessage itself is fine */
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(message, targetOrigin);
        if (options.close !== false) window.close();
        return "postMessage";
      }
    } catch {
      /* fall through */
    }
  }

  const redirectUri = options.redirectUri?.trim();
  if (redirectUri) {
    try {
      const url = new URL(redirectUri);
      if (url.origin !== targetOrigin) {
        return "none";
      }
      const hash = new URLSearchParams();
      for (const [key, value] of Object.entries(message)) {
        if (typeof value === "string") hash.set(key, value);
      }
      url.hash = hash.toString();
      location.assign(url.toString());
      return "fragment";
    } catch {
      return "none";
    }
  }

  return "none";
}

/** Primary snippet — declarative markup; auth.js wires the button. */
export function staticSiteSnippet(opts: {
  brokerBase: string;
  siteOrigin: string;
}): string {
  const script = scriptTagSrc(opts.brokerBase);
  const authorize = brokerAuthorizeUrl(
    {
      origin: opts.siteOrigin,
      state: "", // placeholder stripped below — link omits state so auto-links fill it
      scope: "openid",
    },
    opts.brokerBase,
  );
  // brokerAuthorizeUrl always sets state; for the declarative link we want no state.
  const authorizeLink = (() => {
    const url = new URL(authorize);
    url.searchParams.delete("state");
    return url.toString();
  })();

  return `<!-- OpenSesame static-site auth (declarative; no backend) -->
<script src="${script}" defer></script>
<button type="button" data-opensesame-signin>Sign in</button>
<!-- Or: <a href="${authorizeLink}">Sign in</a> -->
<script>
  window.addEventListener("opensesame:signed_in", function (event) {
    console.log("signed in", event.detail);
    // Optional: OpenSesame.acceptSession(event.detail.session).then(...)
  });
</script>`;
}

/** Power-user snippet — explicit OpenSesame.signIn / acceptSession control. */
export function staticSiteExplicitSnippet(opts: {
  brokerBase: string;
  siteOrigin: string;
}): string {
  const script = scriptTagSrc(opts.brokerBase);
  return `<!-- OpenSesame static-site auth (explicit JS control) -->
<script src="${script}" defer></script>
<button type="button" id="opensesame-signin">Sign in</button>
<script>
  document.getElementById("opensesame-signin").addEventListener("click", function () {
    OpenSesame.signInAndAccept()
      .then(function (result) {
        console.log("subject", result.subject, result.claims);
      })
      .catch(function (err) {
        console.error(err);
      });
  });
</script>`;
}
