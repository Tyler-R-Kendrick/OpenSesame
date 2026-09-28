/**
 * The site broker's stored records, as data (ADR 0034): the consent list and
 * the domain policy, the parsers every stored copy goes through, and the
 * domain normaliser both use. Pure: no storage, no page. Split from
 * `site-broker.ts` so travel (ADR 0143) reads a bundle's records exactly as
 * the broker would.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";

/**
 * Base key names — read and written through the active project's scope, so
 * each project keeps its own approved-site list and domain policy.
 */
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

export type SiteConsent = {
  origin: string;
  scopes: string[];
  approvedAt: string;
  lastUsedAt: string;
};

export function isSiteConsent(value: BoundaryValue): value is SiteConsent {
  return (
    isJsonObject(value) &&
    isString(value.origin) &&
    Array.isArray(value.scopes) &&
    value.scopes.every(isString) &&
    isString(value.approvedAt) &&
    isString(value.lastUsedAt)
  );
}

/** The consents in a stored record; anything malformed grants nothing. */
export function parseConsents(raw: string | null): SiteConsent[] {
  if (!raw) return [];
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed) || !Array.isArray(parsed.consents)) return [];
    return parsed.consents.filter(isSiteConsent);
  } catch {
    return [];
  }
}

export function parseBrokerPolicy(raw: string | null): BrokerPolicy {
  if (!raw) return { rules: [] };
  try {
    const parsed = overlapCast(JSON.parse(raw));

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
        .filter((d): d is string => isString(d))
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

function normalizeRule(row: BoundaryValue): DomainRule | null {
  if (!isJsonObject(row)) return null;
  const domainRaw = row.domain;
  const effectRaw = row.effect;
  if (!isString(domainRaw)) return null;
  const domain = normalizeDomainEntry(domainRaw);
  if (!domain) return null;
  const effect: DomainEffect =
    effectRaw === "blacklist" ? "blacklist" : "whitelist";
  return { domain, effect };
}

export function sortRules(rules: DomainRule[]): DomainRule[] {
  return [...rules].sort((a, b) => a.domain.localeCompare(b.domain));
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
