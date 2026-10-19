/** Vault owns its IdP exchange; the browser retains only the resulting scoped session. */
import { bindNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-binding.js";
import {
  type NativeConnectorDriver,
  type NativeDriverInput,
  registerNativeConnectorDriver,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  type NativeProviderTransport,
  captureNativeProviderAuthority,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import { nativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { parseNativeOAuthCallback } from "@opensesame/app-core/lib/native-oauth-session.js";
import { completeNativeVaultOidc } from "@opensesame/app-core/lib/native-vault-auth.js";
import { nativeVaultCleanup } from "@opensesame/app-core/lib/native-vault-cleanup.js";
import {
  checkNativeVaultAccess,
  readNativeVaultInstance,
  verifyNativeVault,
} from "@opensesame/app-core/lib/native-vault-operations.js";
import {
  authorizeNativeVault,
  cancelNativeVaultOidc,
  configureNativeVault,
} from "@opensesame/app-core/lib/native-vault-session.js";
import type { Activation } from "../activation.js";
import { nativeVaultSecretItems } from "./native-vault-kv-output.js";

function instance(id: string): "vault" | "openbao" {
  const providerId = readNativeConnector(id)?.providerId;
  if (providerId !== "vault" && providerId !== "openbao")
    throw new Error("Saved Vault connection not found");
  return providerId;
}
function validateInput(input: NativeDriverInput): void {
  if (
    input.method !== "oidc" ||
    Object.keys(input.credentials).length ||
    Object.keys(input.requestedScopes).length ||
    Object.keys(input.targetIds).length ||
    Object.keys(input.parameters).some(
      (key) => !["endpoint", "namespace", "auth_mount", "role"].includes(key),
    )
  )
    throw new Error("Select this instance's approved OIDC sign-in fields");
}

async function configureVault(
  input: NativeDriverInput,
  transport: NativeProviderTransport,
) {
  validateInput(input);
  if (input.providerId !== "vault" && input.providerId !== "openbao")
    throw new Error("Select a Vault or OpenBao instance");
  const id = await configureNativeVault(
    {
      providerId: input.providerId,
      connectionId: input.connectionId,
      revision: input.revision,
      endpoint: input.parameters.endpoint ?? "",
      namespace: input.parameters.namespace ?? "",
      authMount: input.parameters.auth_mount ?? "oidc",
      role: input.parameters.role ?? "",
      displayName: input.displayName,
      icon: input.icon,
    },
    transport,
  );
  transport.assertCurrent();
  const view = readNativeConnector(id);
  if (!view) throw new Error("The Vault sign-in request was not saved");
  return view;
}
type Authority = ReturnType<typeof captureNativeProviderAuthority>;
function vaultCleanupRoutes(authority: Authority, activation: Activation) {
  const routes = new Map<
    string,
    {
      fingerprint: string;
      transport: NativeProviderTransport;
    }
  >();
  activation.onDispose(() => routes.clear());
  return {
    assertCurrent(id: string) {
      authority.assertCurrent();
      routes.get(id)?.transport.assertCurrent();
    },
    remember(id: string, transport: NativeProviderTransport) {
      transport.assertCurrent();
      const previous = routes.get(id);
      previous?.transport.assertCurrent();
      const fingerprint = readNativeConnector(id)?.fingerprint;
      if (!fingerprint || (previous && previous.fingerprint !== fingerprint))
        throw new Error("Vault cleanup belongs to another configuration");
      if (!previous) routes.set(id, { fingerprint, transport });
    },
    transport(id: string, expectedFingerprint?: string) {
      authority.assertCurrent();
      const previous = routes.get(id);
      const transport = previous?.transport ?? authority.capture();
      transport.assertCurrent();
      const fingerprint =
        expectedFingerprint ?? readNativeConnector(id)?.fingerprint;
      if (!fingerprint || (previous && previous.fingerprint !== fingerprint))
        throw new Error("Vault cleanup belongs to another configuration");
      if (!previous) routes.set(id, { fingerprint, transport });
      return transport;
    },
  };
}
async function authorizeVault(
  id: string,
  transport: NativeProviderTransport,
  routes: ReturnType<typeof vaultCleanupRoutes>,
) {
  const browser = nativeOAuthBrowserPort();
  if (!browser.authorize)
    throw new Error("This browser cannot receive provider sign-in");
  const consent = await authorizeNativeVault(
    id,
    browser.redirectUri,
    transport,
  );
  routes.remember(id, transport);
  let search: string;
  try {
    search = await browser.authorize(consent.authorizationUrl, consent);
  } catch (error) {
    await cancelNativeVaultOidc(id, consent.state);
    throw error;
  }
  const callback = parseNativeOAuthCallback(search);
  if (callback.error || !callback.code) {
    await cancelNativeVaultOidc(id, consent.state);
    throw new Error("Provider sign-in was cancelled");
  }
  await completeNativeVaultOidc(
    id,
    { state: callback.state, code: callback.code },
    transport,
  );
  transport.assertCurrent();
}
async function invokeVault(
  id: string,
  operation: string,
  input: Record<string, string>,
  transport: NativeProviderTransport,
) {
  if (operation === "provider.read" && !Object.keys(input).length) {
    const facts = await checkNativeVaultAccess(id, transport);
    return {
      label: "Provider access verified",
      items: [{ id: "user", label: facts.tokenLabel }],
    };
  }
  if (
    operation !== "provider.secret.read" ||
    Object.keys(input).some((key) => !["mount", "path"].includes(key))
  )
    throw new Error("Select a supported Vault operation");
  const secret = await readNativeVaultInstance(
    id,
    { mount: input.mount ?? "secret", path: input.path ?? "" },
    transport,
  );
  return {
    label: `Secret version ${secret.metadata.version}`,
    items: nativeVaultSecretItems(secret.data),
  };
}
function vaultRuntimeCleanup(
  authority: Authority,
  routes: ReturnType<typeof vaultCleanupRoutes>,
): NativeConnectorDriver["cleanup"] {
  return {
    classification: (configuration) => {
      const providerId = configuration.providerId;
      if (providerId !== "vault" && providerId !== "openbao")
        throw new Error("This cleanup belongs to another provider");
      return nativeVaultCleanup(providerId, authority.capture()).classification(
        configuration,
      );
    },
    credentialSlots: [],
    prepare: async (id) => {
      const transport = routes.transport(id);
      await nativeVaultCleanup(instance(id), transport).prepare?.(id);
      transport.assertCurrent();
    },
    cleanup: (obligation, context) => {
      const transport = routes.transport(
        context.connectionId,
        context.configuration.fingerprint,
      );
      const providerId = context.configuration.providerId;
      if (providerId !== "vault" && providerId !== "openbao")
        throw new Error("This cleanup belongs to another provider");
      return nativeVaultCleanup(providerId, transport).cleanup(
        obligation,
        context,
      );
    },
  };
}
export function bindNativeVaultRuntime(activation: Activation): void {
  const authority = captureNativeProviderAuthority();
  const routes = vaultCleanupRoutes(authority, activation);
  const driver: NativeConnectorDriver = {
    supports: (id) => id === "vault" || id === "openbao",
    configure: (input) => configureVault(input, authority.capture()),
    authorize: (id) => {
      const transport = authority.capture();
      routes.assertCurrent(id);
      return authorizeVault(id, transport, routes);
    },
    verify: (id) => verifyNativeVault(id, authority.capture()),
    invoke: (id, operation, input) =>
      invokeVault(id, operation, input, authority.capture()),
    cleanup: vaultRuntimeCleanup(authority, routes),
  };
  activation.onDispose(
    registerNativeConnectorDriver(
      "oidc",
      bindNativeConnectorDriver(driver, authority),
    ),
  );
}
