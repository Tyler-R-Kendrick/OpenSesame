/**
 * Provider connection identity, capabilities, and prompt/hint normalization.
 *
 * Capabilities are declared, never inferred from a brand string. The legacy
 * `loginHint` parameter remains domain-only broker routing.
 */

import type {
  AmbientTransport,
  AuthenticationIntent,
  ProviderCapability,
  ProviderConnectionKey,
  ProviderProtocol,
} from "./types.js";

export type ProviderConnection = {
  key: ProviderConnectionKey;
  protocol: ProviderProtocol;
  issuer: string;
  clientId: string;
  organizationBinding?: string;
  tenantAuthority?: string;
  displayName: string;
  capabilities: readonly ProviderCapability[];
};

const KEY_PART = 256;

function validKeyPart(value: string): boolean {
  if (value.includes("|")) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export function providerConnectionKey(input: {
  protocol: ProviderProtocol;
  issuer: string;
  clientId: string;
  organizationBinding?: string;
}): ProviderConnectionKey {
  const issuer = trimSlashes(input.issuer);
  const clientId = input.clientId.trim();
  const org = input.organizationBinding?.trim() ?? "";
  if (
    !issuer ||
    !clientId ||
    issuer.length > KEY_PART ||
    clientId.length > KEY_PART ||
    org.length > KEY_PART ||
    !validKeyPart(issuer) ||
    !validKeyPart(clientId) ||
    !validKeyPart(org)
  ) {
    throw new Error("invalid provider connection");
  }
  // SAFETY: test/fixture or boundary-checked value matches ProviderConnectionKey.
  return `${input.protocol}|${issuer}|${clientId}|${org}` as ProviderConnectionKey;
}

export function parseProviderConnectionKey(key: string): {
  protocol: ProviderProtocol;
  issuer: string;
  clientId: string;
  organizationBinding?: string;
} | null {
  const parts = key.split("|");
  if (parts.length !== 4) return null;
  const [protocol, issuer, clientId, org] = parts;
  if (
    protocol !== "oidc" &&
    protocol !== "entra" &&
    protocol !== "shoo" &&
    protocol !== "fedcm"
  ) {
    return null;
  }
  if (!issuer || !clientId) return null;
  return {
    protocol,
    issuer,
    clientId,
    ...(org ? { organizationBinding: org } : undefined),
  };
}

export const SHOO_CAPABILITIES: readonly ProviderCapability[] = [
  "interactive-oidc",
  "local-logout",
];

export const GENERIC_OIDC_CAPABILITIES: readonly ProviderCapability[] = [
  "interactive-oidc",
  "silent-redirect",
  "account-selection",
  "reauthentication",
  "local-logout",
];

export const ENTRA_CAPABILITIES: readonly ProviderCapability[] = [
  "interactive-oidc",
  "silent-redirect",
  "silent-iframe",
  "account-selection",
  "reauthentication",
  "local-logout",
];

export function capabilitiesForProtocol(
  protocol: ProviderProtocol,
): readonly ProviderCapability[] {
  if (protocol === "shoo") return SHOO_CAPABILITIES;
  if (protocol === "entra") return ENTRA_CAPABILITIES;
  if (protocol === "fedcm") return ["fedcm-auto", "local-logout"] as const;
  return GENERIC_OIDC_CAPABILITIES;
}

export function supportsCapability(
  connection: Pick<ProviderConnection, "capabilities">,
  capability: ProviderCapability,
): boolean {
  return connection.capabilities.includes(capability);
}

const ENTRA_ISSUER_HOSTS: ReadonlySet<string> = new Set([
  "login.microsoftonline.com",
  "login.windows.net",
  "login.microsoftonline.us",
  "login.partner.microsoftonline.cn",
]);

function hasEntraHost(issuer: string): boolean {
  try {
    return ENTRA_ISSUER_HOSTS.has(new URL(issuer).hostname);
  } catch {
    return false;
  }
}

export function protocolForIssuer(
  issuer: string,
  providerId?: string,
): ProviderProtocol {
  const trimmed = trimSlashes(issuer).toLowerCase();
  const id = (providerId ?? "").toLowerCase();
  if (trimmed === "https://shoo.dev" || id === "shoo") return "shoo";
  if (id === "microsoft" || id === "entra" || hasEntraHost(trimmed)) {
    return "entra";
  }
  return "oidc";
}

export type NormalizedHints = {
  /** Domain-only broker routing. Never an email local-part. */
  brokerDomain?: string;
  entraLoginHint?: string;
  sessionHint?: string;
  tenantAuthority?: string;
};

/**
 * Preserve the existing `loginHint` privacy contract: domain only, for
 * broker home-realm discovery. Entra account/session/tenant hints are
 * separate fields and must be set explicitly.
 */
export function domainOnlyBrokerHint(
  loginHint: string | undefined,
): string | undefined {
  if (!loginHint) return undefined;
  const trimmed = loginHint.trim().toLowerCase();
  if (!trimmed || trimmed.includes("@") || trimmed.length > 253)
    return undefined;
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(trimmed)) return undefined;
  return trimmed;
}

export type NormalizedAuthorizePrompt =
  | { prompt: "none" }
  | { prompt: "login" }
  | { prompt: "select_account" }
  | { prompt: "consent" }
  | { omitted: true };

export function normalizePrompt(input: {
  intent: AuthenticationIntent;
  transport?: AmbientTransport;
  protocol: ProviderProtocol;
}):
  | { ok: true; prompt: NormalizedAuthorizePrompt }
  | { ok: false; reason: "unsupported" | "contradictory" } {
  if (input.protocol === "shoo") {
    if (input.intent.kind === "ambient") {
      return { ok: false, reason: "unsupported" };
    }
    return { ok: true, prompt: { omitted: true } };
  }
  if (input.intent.kind === "ambient") {
    if (input.transport === "interactive-continue") {
      return { ok: true, prompt: { omitted: true } };
    }
    return { ok: true, prompt: { prompt: "none" } };
  }
  if (input.intent.kind === "switch-account") {
    return { ok: true, prompt: { prompt: "select_account" } };
  }
  if (input.intent.kind === "reauthenticate") {
    return { ok: true, prompt: { prompt: "login" } };
  }
  return { ok: true, prompt: { omitted: true } };
}

export function applyPromptParams(
  params: URLSearchParams,
  prompt: NormalizedAuthorizePrompt,
): void {
  if ("omitted" in prompt) return;
  params.set("prompt", prompt.prompt);
}

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
