/** Key Vault secret list/get through the same captured transport and sealed native key flows. */
import { canonicalize } from "@opensesame/os-domain";
import { canonicalProviderId } from "./connector-catalog.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import {
  NativeApiError,
  type NativeApiHttpRequest,
  nativeApiHttp,
} from "./native-api-http.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { createNativeKeyFlows } from "./native-key-driver.js";
import type { NativeKeyTarget, NativeKeyUi } from "./native-key-types.js";
import {
  AZURE_API_VERSION,
  azureNextPage,
  azureSecretBundle,
  azureSecretPage,
  azureSecretPath,
  azureSecretReference,
  azureVaultBase,
} from "./secret-backends/azure-key-vault-codec.js";

const PUBLIC = ["vault_url"];
const PRIVATE = ["token"];
const accepts = (id: string) => canonicalProviderId(id) === "azure-sm";
function assertAzureFields(input: NativeApiConfigureInput): void {
  if (
    !accepts(input.providerId) ||
    Object.keys(input.requestedScopes ?? {}).length ||
    Object.keys(input.targetIds ?? {}).length ||
    Object.keys(input.parameters).some((key) => !PUBLIC.includes(key)) ||
    Object.keys(input.credentials).some((key) => !PRIVATE.includes(key))
  )
    throw new Error(
      "Configure only a vault URL and its Key Vault access token",
    );
}
function targetOf(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): NativeKeyTarget {
  assertAzureFields(input);
  const origin = azureVaultBase(input.parameters.vault_url ?? "").origin;
  const supplied = input.credentials.token ?? "";
  if (!supplied && saved && saved.configuration.parameters.vault_url !== origin)
    throw new Error("Supply an access token when changing the vault URL");
  const token = supplied || saved?.privateState.credentials.token || "";
  if (!/^[\x21-\x7e]{1,16384}$/.test(token))
    throw new Error("Supply a Key Vault audience Bearer access token");
  const credentials = { token };
  safeProviderText(origin, credentials);
  safeProviderText(input.displayName, credentials);
  safeNativeConnectorIcon(input.icon ?? "", credentials);
  return {
    providerId: input.providerId,
    parameters: { vault_url: origin },
    credentials,
  };
}
async function get(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  path: string,
  list = false,
) {
  transport.assertCurrent();
  const base = azureVaultBase(target.parameters.vault_url ?? "");
  const url = new URL(path, base);
  url.searchParams.set("api-version", AZURE_API_VERSION);
  if (list) url.searchParams.set("maxresults", "25");
  const request: NativeApiHttpRequest = {
    url,
    method: "GET",
    headers: new Headers({
      Authorization: `Bearer ${target.credentials.token}`,
      Accept: "application/json",
    }),
  };
  if (transport.signal) request.signal = transport.signal;
  return nativeApiHttp(request, transport);
}
async function names(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
) {
  const base = azureVaultBase(target.parameters.vault_url ?? "");
  const page = azureSecretPage(
    await get(target, transport, "/secrets", true),
    base,
  );
  // Validate provider pagination without following it or broadening this first-page read.
  if (page.next) azureNextPage(page.next, base);
  if (new Set(page.items.map((item) => item.id)).size !== page.items.length)
    throw new NativeApiError("response");
  const items = page.items.map((item) => ({
    id: item.id,
    label: safeProviderText(item.name, target.credentials),
  }));
  return {
    label: `Showing ${items.length} secret names from first page`,
    items,
  };
}
async function value(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  name: string,
) {
  const base = azureVaultBase(target.parameters.vault_url ?? "");
  const ref = azureSecretReference(name, base);
  const bundle = azureSecretBundle(
    await get(target, transport, azureSecretPath(ref)),
    base,
    ref,
  );
  const token = target.credentials.token ?? "";
  if (
    bundle.value.includes(token) ||
    bundle.value.includes(encodeURIComponent(token))
  )
    throw new NativeApiError("response");
  return {
    label: "Secret read once",
    items: [{ id: ref.id, label: ref.name, secretValue: bundle.value }],
  };
}
function ui(): NativeKeyUi {
  return {
    name: "Azure Key Vault Secrets",
    methodLabel: "Key Vault access token",
    instructions:
      "Supply your vault URL and an issued Bearer access token for the Key Vault audience https://vault.azure.net. The token needs secret list/get permission in that vault. Microsoft Graph tokens are not used. Requests use the configured native transport; no application server is required. Replace an expired token here.",
    fields: [
      {
        id: "vault_url",
        label: "Vault URL",
        kind: "url",
        secret: false,
        required: true,
        placeholder: "https://my-vault.vault.azure.net",
      },
      {
        id: "token",
        label: "Key Vault access token",
        kind: "text",
        secret: true,
        required: true,
      },
    ],
    links: [
      {
        label: "Key Vault secret permissions",
        url: "https://learn.microsoft.com/en-us/azure/key-vault/secrets/about-secrets",
      },
    ],
    disconnectExplanation:
      "Disconnect forgets this device's token. It does not revoke the Azure token or change your vault.",
    actions: [
      { id: "provider.secrets.read", label: "List secret names", fields: [] },
      {
        id: "provider.secret.read",
        label: "Read a secret",
        fields: [
          {
            id: "name",
            label: "Secret name or versioned ID",
            kind: "text",
            secret: false,
            required: true,
          },
        ],
      },
    ],
  };
}
export const azureSecretsKeyFlows = createNativeKeyFlows<NativeKeyTarget>({
  family: "Azure Key Vault Secrets",
  idPrefix: "conn_azure_secrets_",
  accepts,
  classification: { publicParameters: PUBLIC, privateCredentials: PRIVATE },
  ui,
  parse: targetOf,
  fingerprint: async (target) => {
    const encoded = new TextEncoder().encode(
      canonicalize({
        contract: "azure-secrets:list-get:v1",
        parameters: target.parameters,
        credentials: target.credentials,
      }),
    );
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoded))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  },
  prove: async (target, transport) => {
    await names(target, transport);
    const origin = target.parameters.vault_url ?? "";
    return {
      identity: { id: origin, label: new URL(origin).hostname, kind: "vault" },
      targets: [{ id: origin, label: origin, kind: "vault" }],
      grantLabel: "Azure Key Vault secret list access",
      target: { key: "vault_url", id: origin },
    };
  },
  targetOf: (saved) =>
    targetOf(
      {
        providerId: saved.configuration.providerId,
        displayName: saved.configuration.displayName,
        icon: saved.configuration.icon,
        parameters: saved.configuration.parameters,
        credentials: saved.privateState.credentials,
      },
      saved,
    ),
  operations: [
    { id: "provider.secrets.read", inputKeys: [], run: names },
    {
      id: "provider.secret.read",
      inputKeys: ["name"],
      run: (target, transport, input) =>
        value(target, transport, input.name ?? ""),
    },
  ],
});
