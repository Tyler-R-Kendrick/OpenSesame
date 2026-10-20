import {
  type NativeAzureSecretsOptions,
  openSavedAzureSecrets,
} from "../native-azure-secrets-backup.js";
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
type LocalBackendMode = Exclude<SecretBackendMode, HttpBackendMode>;

async function localBackend(mode: LocalBackendMode, check: () => void) {
  switch (mode) {
    case "local": {
      const module = await import("./local.js");
      check();
      return module.createLocalVaultBackend();
    }
    case "file-import": {
      const module = await import("./file-import.js");
      check();
      return module.createFileImportBackend();
    }
    case "credential-management": {
      const module = await import("./credential-management.js");
      check();
      return module.createCredentialManagementBackend();
    }
  }
}

async function httpBackend(
  mode: HttpBackendMode,
  transport: SecretBackendTransport,
  savedConnectionId?: string,
): Promise<SecretBackend> {
  switch (mode) {
    case "encrypted-remote": {
      const module = await import("./encrypted-remote-saved.js");
      transport.assertCurrent();
      return module.createSavedEncryptedRemoteBackend(
        transport,
        savedConnectionId,
      );
    }
    case "proton-pass": {
      const module = await import("./proton-pass-backend.js");
      transport.assertCurrent();
      return module.createProtonPassBackend(transport);
    }
    case "onepassword-sdk": {
      const [module, loader] = await Promise.all([
        import("./onepassword-sdk.js"),
        import("./onepassword-sdk-loader.js"),
      ]);
      transport.assertCurrent();
      const assets = loader.onePasswordBrowserAssets();
      transport.assertCurrent();
      return module.createOnePasswordSdkBackend(assets, transport);
    }
    case "onepassword-connect": {
      const module = await import("./onepassword.js");
      transport.assertCurrent();
      return module.createOnePasswordConnectBackend(transport.fetch);
    }
    case "bitwarden-api": {
      const module = await import("./bitwarden-native-browser.js");
      transport.assertCurrent();
      return module.createBitwardenNativeBrowserBackend(transport);
    }
    case "bitwarden-secrets": {
      const module = await import("./bitwarden-secrets.js");
      transport.assertCurrent();
      return module.createBitwardenSecretsBackend(
        transport.fetch,
        undefined,
        transport.signal,
      );
    }
    case "infisical": {
      const module = await import("./infisical.js");
      transport.assertCurrent();
      return module.createInfisicalBackend(transport.fetch);
    }
    case "passwordstate": {
      const module = await import("./passwordstate.js");
      transport.assertCurrent();
      return module.createPasswordstateBackend(transport.fetch);
    }
  }
}

/** Optional SDKs and import parsers load only after the person chooses that method. */
export async function createSecretBackend(
  mode: SecretBackendMode,
  assertCurrent?: () => void,
  ownerSignal?: AbortSignal,
  savedConnectionId?: string,
  originalTransport?: SecretBackendTransport,
): Promise<SecretBackend> {
  const check = () => {
    if (ownerSignal?.aborted)
      throw new SecretBackendError("stale", "The backend operation ended.");
    assertCurrent?.();
    if (ownerSignal?.aborted)
      throw new SecretBackendError("stale", "The backend operation ended.");
  };
  check();
  switch (mode) {
    case "local":
    case "file-import":
    case "credential-management": {
      const backend = await localBackend(mode, check);
      check();
      return fenceSecretBackend(backend, {
        signal: ownerSignal ?? new AbortController().signal,
        assertCurrent: check,
      });
    }
    case "encrypted-remote":
    case "proton-pass":
    case "onepassword-sdk":
    case "onepassword-connect":
    case "bitwarden-api":
    case "bitwarden-secrets":
    case "infisical":
    case "passwordstate": {
      const transport = guardSecretBackendTransport(
        originalTransport ?? secretBackendTransport(),
        assertCurrent,
        ownerSignal,
      );
      const backend = await httpBackend(mode, transport, savedConnectionId);
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

/** Open the existing sealed native Azure record through the common secret-store port. */
export function openSavedAzureKeyVaultBackend(
  id: string,
  options: NativeAzureSecretsOptions,
) {
  return openSavedAzureSecrets(id, options);
}
