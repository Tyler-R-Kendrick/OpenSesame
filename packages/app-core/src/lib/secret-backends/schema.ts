import { z } from "zod";
import { secretBackendUrl } from "./http.js";
import { secretBackendPreset } from "./presets.js";
import { protonConfiguration, splitProtonPat } from "./proton-pass-protocol.js";
import { SecretBackendError } from "./types.js";

const text = z.string().max(4096).default("");
export const SecretBackendDraftSchema = z.object({
  providerId: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  mode: z.enum([
    "local",
    "file-import",
    "credential-management",
    "proton-pass",
    "onepassword-sdk",
    "onepassword-connect",
    "bitwarden-api",
    "bitwarden-secrets",
    "infisical",
    "passwordstate",
  ]),
  baseUrl: text,
  identityUrl: text,
  appVersion: text,
  token: z.string().max(32768).default(""),
  vaultId: text,
  projectId: text,
  organizationId: text,
  environment: text,
  secretPath: text,
  clientId: text,
  clientSecret: z.string().max(32768).default(""),
  passwordListId: text,
  fileFormat: text,
  accountEmail: text,
  deviceIdentifier: text,
});

export const SECRET_BACKEND_CREDENTIAL_FIELDS = [
  "token",
  "clientSecret",
] as const;

type Draft = z.infer<typeof SecretBackendDraftSchema>;
type DraftInput = z.input<typeof SecretBackendDraftSchema>;

function validateProtocol(draft: Draft): void {
  const preset = secretBackendPreset(draft.providerId);
  if (!preset || !preset.modes.includes(draft.mode))
    throw new SecretBackendError(
      "configuration",
      "Choose a supported connection method for this provider.",
    );
  if (
    draft.mode === "file-import" &&
    !preset.fileFormats.some((format) => format.id === draft.fileFormat)
  )
    throw new SecretBackendError(
      "configuration",
      "Choose a supported export file format.",
    );
  if (!["local", "file-import", "credential-management"].includes(draft.mode))
    secretBackendUrl(draft.baseUrl);
  if (draft.identityUrl) secretBackendUrl(draft.identityUrl);
}

function validateNativeOnePassword(draft: Draft): void {
  if (draft.mode !== "onepassword-sdk") return;
  if (
    secretBackendUrl(draft.baseUrl).pathname !== "/" ||
    !draft.vaultId.trim() ||
    draft.vaultId.length > 1024 ||
    draft.token.length > 16_384
  )
    throw new SecretBackendError(
      "configuration",
      "Enter a 1Password account origin, vault ID and service account token within the supported limits.",
    );
}

function validateNativeProton(draft: Draft, requireCredentials: boolean): void {
  if (draft.mode !== "proton-pass") return;
  protonConfiguration(draft);
  if (requireCredentials || draft.token) {
    const parsed = splitProtonPat(draft.token);
    parsed.raw.fill(0);
  }
}

function validateTargets(draft: Draft): void {
  if (draft.mode === "onepassword-connect" && !draft.vaultId.trim())
    throw new SecretBackendError(
      "configuration",
      "Enter the 1Password vault ID.",
    );
  if (
    draft.mode === "infisical" &&
    (!draft.projectId.trim() || !draft.environment.trim())
  )
    throw new SecretBackendError(
      "configuration",
      "Enter the Infisical project and environment.",
    );
  if (draft.mode === "passwordstate" && !/^\d+$/.test(draft.passwordListId))
    throw new SecretBackendError(
      "configuration",
      "Enter the Passwordstate password list ID.",
    );
}

function requirePrivateCredentials(draft: Draft): void {
  if (
    [
      "onepassword-sdk",
      "onepassword-connect",
      "bitwarden-secrets",
      "passwordstate",
    ].includes(draft.mode) &&
    !draft.token.trim()
  )
    throw new SecretBackendError(
      "configuration",
      "Enter the access token or API key.",
    );
  if (
    draft.mode === "infisical" &&
    !draft.token &&
    (!draft.clientId || !draft.clientSecret)
  )
    throw new SecretBackendError(
      "configuration",
      "Enter a machine identity client ID and secret, or an access token.",
    );
}

function protectCredentialFields(draft: Draft): void {
  for (const field of SECRET_BACKEND_CREDENTIAL_FIELDS) {
    const secret = draft[field];
    if (secret.length >= 4 && draft.name.includes(secret))
      throw new SecretBackendError(
        "configuration",
        "Keep credentials out of the connection name.",
      );
    if (/\r|\n/u.test(secret) || secret.includes(String.fromCharCode(0)))
      throw new SecretBackendError(
        "configuration",
        "Credentials must not contain line breaks or null characters.",
      );
  }
}

export function validateSecretBackendDraft(
  value: DraftInput,
  requireCredentials = true,
) {
  const result = SecretBackendDraftSchema.safeParse(value);
  if (!result.success)
    throw new SecretBackendError(
      "configuration",
      "Check the secret backend configuration fields.",
    );
  const draft = result.data;
  validateProtocol(draft);
  validateNativeOnePassword(draft);
  validateNativeProton(draft, requireCredentials);
  validateTargets(draft);
  if (requireCredentials) requirePrivateCredentials(draft);
  protectCredentialFields(draft);
  return draft;
}

export function publicSecretBackendDraft(value: DraftInput) {
  const draft = SecretBackendDraftSchema.parse(value);
  for (const field of SECRET_BACKEND_CREDENTIAL_FIELDS) draft[field] = "";
  return draft;
}
