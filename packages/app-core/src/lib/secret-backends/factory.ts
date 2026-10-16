import {
  type SecretBackendTransport,
  fenceSecretBackend,
  guardSecretBackendTransport,
  secretBackendTransport,
} from "./transport.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendMode,
} from "./types.js";

type HttpBackendMode = Exclude<
  SecretBackendMode,
  "local" | "file-import" | "credential-management"
>;

async function httpBackend(
  mode: HttpBackendMode,
  transport: SecretBackendTransport,
): Promise<SecretBackend> {
  switch (mode) {
    case "onepassword-connect":
      return (await import("./onepassword.js")).createOnePasswordConnectBackend(
        transport.fetch,
      );
    case "bitwarden-api":
      return (await import("./bitwarden.js")).createBitwardenApiBackend(
        transport.fetch,
      );
    case "bitwarden-secrets":
      return (
        await import("./bitwarden-secrets.js")
      ).createBitwardenSecretsBackend(
        transport.fetch,
        undefined,
        transport.signal,
      );
    case "infisical":
      return (await import("./infisical.js")).createInfisicalBackend(
        transport.fetch,
      );
    case "passwordstate":
      return (await import("./passwordstate.js")).createPasswordstateBackend(
        transport.fetch,
      );
  }
}

/** Optional SDKs and import parsers load only after the person chooses that method. */
export async function createSecretBackend(
  mode: SecretBackendMode,
  assertCurrent?: () => void,
): Promise<SecretBackend> {
  switch (mode) {
    case "local":
      return (await import("./local.js")).createLocalVaultBackend();
    case "file-import":
      return (await import("./file-import.js")).createFileImportBackend();
    case "credential-management":
      return (
        await import("./credential-management.js")
      ).createCredentialManagementBackend();
    case "onepassword-connect":
    case "bitwarden-api":
    case "bitwarden-secrets":
    case "infisical":
    case "passwordstate": {
      const transport = guardSecretBackendTransport(
        secretBackendTransport(),
        assertCurrent,
      );
      const backend = await httpBackend(mode, transport);
      transport.assertCurrent();
      return fenceSecretBackend(backend, transport);
    }
    default:
      throw new SecretBackendError(
        "configuration",
        "Choose a supported secret backend method.",
      );
  }
}
