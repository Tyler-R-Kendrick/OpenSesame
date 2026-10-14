import { identityConnectionPreset } from "@opensesame/app-core/lib/identity-connections-presets.js";
import type { IdentityConnectionDraft } from "@opensesame/app-core/lib/identity-connections-schema.js";
import { FieldShell } from "../../../components/FieldShell.js";

export type IdentityField = {
  key: keyof IdentityConnectionDraft;
  label: string;
  placeholder?: string;
  secret?: boolean;
};
export type IdentityFieldProps = {
  draft: IdentityConnectionDraft;
  busy: boolean;
  onChange: (key: keyof IdentityConnectionDraft, value: string) => void;
};
export function IdentityDraftFields({
  draft,
  busy,
  onChange,
  fields,
}: IdentityFieldProps & { fields: IdentityField[] }) {
  const preset = identityConnectionPreset(draft.providerId);
  const placeholders = {
    issuer: preset?.issuerPlaceholder,
    baseUrl: preset?.baseUrlPlaceholder,
  };
  return fields.map((field) => (
    <FieldShell
      key={field.key}
      label={field.label}
      value={String(draft[field.key] ?? "")}
      placeholder={
        field.key === "issuer" || field.key === "baseUrl"
          ? placeholders[field.key]
          : field.placeholder
      }
      type={field.secret ? "password" : "text"}
      autoComplete={field.secret ? "new-password" : "off"}
      mono
      disabled={busy}
      onValueChange={(value) => onChange(field.key, value)}
    />
  ));
}
export const OIDC_FIELDS: IdentityField[] = [
  { key: "issuer", label: "Issuer URL" },
  { key: "clientId", label: "Public client ID" },
];
export const OIDC_OPTIONS: IdentityField[] = [
  { key: "scope", label: "Scopes", placeholder: "openid profile email" },
  { key: "clientSecret", label: "Client secret (server client)", secret: true },
];
export const SAML_FIELDS: IdentityField[] = [
  { key: "samlEntityId", label: "SAML entity ID" },
  {
    key: "samlMetadataUrl",
    label: "SAML metadata URL",
    placeholder: "https://idp.example.com/metadata",
  },
];
export const TOKEN_FIELDS: IdentityField[] = [
  { key: "issuer", label: "Token issuer override" },
  { key: "audience", label: "Token audience override" },
  { key: "jwksUri", label: "JWKS URL override" },
];
export const LDAP_FIELDS: IdentityField[] = [
  {
    key: "ldapUrl",
    label: "LDAP server URL",
    placeholder: "ldaps://directory.example.com:636",
  },
  {
    key: "ldapBaseDn",
    label: "Search base DN",
    placeholder: "ou=people,dc=example,dc=com",
  },
];
export const LDAP_OPTIONS: IdentityField[] = [
  {
    key: "ldapBindTemplate",
    label: "Bind DN template",
    placeholder: "uid={username},ou=people,dc=example,dc=com",
  },
  {
    key: "ldapSearchFilter",
    label: "Search filter",
    placeholder: "(uid={username})",
  },
  { key: "ldapBindDn", label: "Service bind DN" },
  { key: "ldapBindPassword", label: "Service bind password", secret: true },
  {
    key: "ldapSubjectAttribute",
    label: "Subject attribute",
    placeholder: "entryUUID",
  },
  { key: "ldapEmailAttribute", label: "Email attribute", placeholder: "mail" },
  { key: "ldapNameAttribute", label: "Name attribute", placeholder: "cn" },
];
