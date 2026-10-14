import { canonicalProviderId } from "../connector-catalog.js";
import type { SourceId } from "../vault/import/types.js";
import { SECRET_BACKEND_PRESETS } from "./presets.generated.js";
import type { SecretBackendDraft, SecretBackendMode } from "./types.js";

export type SecretBackendPreset = {
  providerId: string;
  label: string;
  docsUrl: string;
  setup: string;
  modes: SecretBackendMode[];
  defaultMode: SecretBackendMode;
  fileFormats: { id: SourceId; label: string }[];
};

export function secretBackendPreset(
  providerId: string,
): SecretBackendPreset | null {
  const canonical = canonicalProviderId(providerId) ?? providerId;
  return (
    SECRET_BACKEND_PRESETS.find((entry) => entry.providerId === canonical) ??
    null
  );
}

export function isSecretBackendProvider(providerId: string): boolean {
  return secretBackendPreset(providerId) !== null;
}

export function secretBackendDraft(providerId: string): SecretBackendDraft {
  const preset = secretBackendPreset(providerId);
  if (!preset) throw new Error("Unknown secret backend provider");
  return {
    providerId,
    name: preset.label,
    mode: preset.defaultMode,
    baseUrl: "",
    identityUrl: "",
    token: "",
    vaultId: "",
    projectId: "",
    organizationId: "",
    environment: "dev",
    secretPath: "/",
    clientId: "",
    clientSecret: "",
    passwordListId: "",
    fileFormat: preset.fileFormats[0]?.id ?? "",
  };
}

export function secretBackendModeLabel(mode: SecretBackendMode) {
  const labels = {
    local: "This device's vault",
    "file-import": "Import an export file",
    "credential-management": "Browser password credentials",
    "onepassword-connect": "1Password Connect API",
    "bitwarden-api": "Bitwarden Vault Management API",
    "bitwarden-secrets": "Bitwarden Secrets Manager",
    infisical: "Infisical Secrets API",
    passwordstate: "Passwordstate API",
  } as const satisfies Record<SecretBackendMode, string>;
  return labels[mode];
}
