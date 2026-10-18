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

export const PROTON_PASS_PUBLIC_APP_VERSION = "cli-pass@2.4.2";

export function secretBackendDraft(providerId: string): SecretBackendDraft {
  const preset = secretBackendPreset(providerId);
  if (!preset) throw new Error("Unknown secret backend provider");
  const draft: SecretBackendDraft = {
    providerId,
    name: preset.label,
    mode: preset.defaultMode,
    baseUrl:
      preset.providerId === "bitwarden" ? "https://api.bitwarden.com" : "",
    identityUrl:
      preset.providerId === "bitwarden" ? "https://identity.bitwarden.com" : "",
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
  if (draft.mode === "proton-pass")
    draft.appVersion = PROTON_PASS_PUBLIC_APP_VERSION;
  return draft;
}

export function secretBackendModeLabel(mode: SecretBackendMode) {
  const labels = {
    "encrypted-remote": "Encrypted remote object",
    local: "This device's vault",
    "file-import": "Import an export file",
    "credential-management": "Browser password credentials",
    "proton-pass": "Proton Pass native API",
    "onepassword-sdk": "1Password native SDK",
    "onepassword-connect": "1Password Connect API",
    "bitwarden-api": "Bitwarden-compatible personal vault",
    "bitwarden-secrets": "Bitwarden Secrets Manager",
    infisical: "Infisical Secrets API",
    passwordstate: "Passwordstate API",
  } as const satisfies Record<SecretBackendMode | "encrypted-remote", string>;
  return labels[mode];
}
