import type {
  SecretBackendDraft,
  SecretBackendMode,
} from "@opensesame/app-core/lib/secret-backends/types.js";
import { FieldShell } from "../../../components/FieldShell.js";

export type SecretBackendFieldProps = {
  draft: SecretBackendDraft;
  busy: boolean;
  onChange: (key: keyof SecretBackendDraft, value: string) => void;
};
type Field = {
  key: keyof SecretBackendDraft;
  label: string;
  secret?: boolean;
  placeholder?: string;
};
const endpoint: Field = { key: "baseUrl", label: "API base URL" };
const token: Field = { key: "token", label: "Access token", secret: true };
const API_FIELDS = {
  "encrypted-remote": [
    { key: "baseUrl", label: "Encrypted object HTTPS URL" },
    { key: "remoteStoreId", label: "Encrypted store UUID" },
    {
      key: "encryptionKey",
      label: "Inventory encryption key (base64, 32 bytes)",
      secret: true,
    },
    { key: "token", label: "Object bearer token (optional)", secret: true },
  ],
  "proton-pass": [
    {
      key: "baseUrl",
      label: "API base URL",
      placeholder: "https://pass-api.proton.me/api",
    },
    { key: "token", label: "Personal access token", secret: true },
    { key: "vaultId", label: "PAT-scoped share ID" },
    {
      key: "appVersion",
      label: "Accepted application/version header",
      placeholder: "accepted-client@version",
    },
  ],
  "onepassword-sdk": [
    {
      key: "baseUrl",
      label: "1Password account URL",
      placeholder: "https://team.1password.com",
    },
    { key: "token", label: "Service account token", secret: true },
    { key: "vaultId", label: "Vault ID" },
  ],
  "onepassword-connect": [
    endpoint,
    token,
    { key: "vaultId", label: "Vault ID" },
  ],
  "bitwarden-api": [
    endpoint,
    { key: "identityUrl", label: "Identity API URL" },
    { key: "accountEmail", label: "Account email" },
    {
      key: "clientId",
      label: "Personal API client ID",
      placeholder: "user.00000000-0000-0000-0000-000000000000",
    },
    { key: "clientSecret", label: "Personal API client secret", secret: true },
    { key: "deviceIdentifier", label: "Device identifier" },
    { key: "vaultId", label: "Personal folder ID (optional)" },
  ],
  "bitwarden-secrets": [
    endpoint,
    { key: "identityUrl", label: "Identity API URL" },
    token,
    { key: "organizationId", label: "Organization ID" },
    { key: "projectId", label: "Project ID" },
  ],
  infisical: [
    endpoint,
    token,
    { key: "projectId", label: "Project ID" },
    { key: "environment", label: "Environment" },
    { key: "secretPath", label: "Secret path", placeholder: "/" },
  ],
  passwordstate: [
    endpoint,
    { key: "token", label: "API key", secret: true },
    { key: "passwordListId", label: "Password list ID" },
  ],
} satisfies Partial<Record<SecretBackendMode, Field[]>>;

function DraftFields({
  draft,
  busy,
  onChange,
  fields,
}: SecretBackendFieldProps & { fields: Field[] }) {
  return fields.map((field) => (
    <FieldShell
      key={field.key}
      label={field.label}
      value={draft[field.key] ?? ""}
      type={field.secret ? "password" : "text"}
      placeholder={field.placeholder}
      autoComplete={field.secret ? "new-password" : "off"}
      mono
      disabled={busy}
      onValueChange={(value) => onChange(field.key, value)}
    />
  ));
}

export function SecretBackendFields(props: SecretBackendFieldProps) {
  const mode = props.draft.mode;
  if (mode === "local" || mode === "file-import") return null;
  if (mode === "credential-management")
    return (
      <FieldShell
        label="Credential origin"
        value={window.location.origin}
        mono
        readOnly
      />
    );
  return (
    <>
      <DraftFields {...props} fields={API_FIELDS[mode]} />
      {mode === "infisical" ? (
        <details className="conn-client-alt">
          <summary>Universal Auth</summary>
          <DraftFields
            {...props}
            fields={[
              { key: "clientId", label: "Client ID" },
              { key: "clientSecret", label: "Client secret", secret: true },
            ]}
          />
        </details>
      ) : null}
    </>
  );
}
