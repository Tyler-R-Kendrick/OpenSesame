import { identityConnectionPreset } from "@opensesame/app-core/lib/identity-connections-presets.js";
import type { IdentityProtocol } from "@opensesame/app-core/lib/identity-connections-schema.js";

export const IDENTITY_PROTOCOL_LABELS = {
  oidc: "OpenID Connect (OIDC)",
  saml: "SAML 2.0",
  ldap: "LDAP / Active Directory",
  "better-auth": "Email and password",
  supabase: "Email and password",
} satisfies Record<IdentityProtocol, string>;
const CATALOG_PROTOCOL_LABELS = {
  oidc: "OIDC",
  saml: "SAML",
  ldap: "LDAP",
  "better-auth": "Email/password",
  supabase: "Email/password",
} satisfies Record<IdentityProtocol, string>;

export function identityConnectionMethodLabel(
  providerId: string,
): string | null {
  const preset = identityConnectionPreset(providerId);
  return preset
    ? [
        ...new Set(
          preset.protocols.map((protocol) => CATALOG_PROTOCOL_LABELS[protocol]),
        ),
      ].join(" · ")
    : null;
}

export function identityProtocolLabel(
  protocol: IdentityProtocol,
  providerId: string,
): string {
  if (providerId === "byo-identity" && protocol === "better-auth")
    return "Cookie session (Better Auth API)";
  if (providerId === "byo-identity" && protocol === "supabase")
    return "Token session (Supabase Auth API)";
  return IDENTITY_PROTOCOL_LABELS[protocol];
}
