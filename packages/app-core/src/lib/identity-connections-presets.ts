/** Partner experiences compose the same identity protocols and configuration. */
import {
  type IdentityConnectionDraft,
  IdentityConnectionDraftSchema,
  type IdentityProtocol,
} from "./identity-connections-schema.js";

export type IdentityConnectionPreset = {
  id: string;
  label: string;
  protocols: IdentityProtocol[];
  issuerPlaceholder: string;
  baseUrlPlaceholder: string;
  setup: string;
  docsUrl: string;
};
export { IDENTITY_CONNECTION_PRESETS } from "./identity-presets.generated.js";
import { IDENTITY_CONNECTION_PRESETS } from "./identity-presets.generated.js";
export function identityConnectionPreset(
  providerId: string,
): IdentityConnectionPreset | null {
  return (
    IDENTITY_CONNECTION_PRESETS.find((preset) => preset.id === providerId) ??
    null
  );
}
export function identityConnectionDraft(
  providerId: string,
): IdentityConnectionDraft {
  const preset = identityConnectionPreset(providerId);
  if (!preset) throw new Error("Unknown identity integration");
  return IdentityConnectionDraftSchema.parse({
    providerId,
    name: preset.label,
    protocol: preset.protocols[0] ?? "oidc",
    issuer: "",
    clientId: "",
    audience: "",
    jwksUri: "",
    clientSecret: "",
    scope: "openid profile email",
    baseUrl: "",
    publicKey: "",
    brokerUrl: "",
    organizationId: "",
    organizationSlug: "",
    samlMetadataUrl: "",
    samlMetadataXml: "",
    samlEntityId: "",
    ldapUrl: "",
    ldapBaseDn: "",
    ldapBindDn: "",
    ldapBindPassword: "",
    ldapBindMode: "bind_template",
    ldapBindTemplate: "",
    ldapSearchFilter: "(uid={username})",
    ldapSubjectAttribute: "entryUUID",
    ldapEmailAttribute: "mail",
    ldapNameAttribute: "cn",
  });
}
