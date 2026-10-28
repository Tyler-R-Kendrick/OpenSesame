import { canonicalize } from "@opensesame/os-domain";
import { isJsonObject, isString } from "@opensesame/os-domain";
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
  azureVaultBase,
} from "./secret-backends/azure-key-vault-codec.js";

const PUBLIC = ["vault_url"];
const PRIVATE = ["token"];
const KEY_NAME = /^[A-Za-z0-9-]{1,127}$/;

function accepts(providerId: string): boolean {
  return canonicalProviderId(providerId) === "azure-kms";
}

function assertTargetInput(input: NativeApiConfigureInput): void {
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

function targetToken(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
  origin: string,
): string {
  const supplied = input.credentials.token ?? "";
  if (!supplied && saved && saved.configuration.parameters.vault_url !== origin)
    throw new Error("Supply an access token when changing the vault URL");
  const token = supplied || saved?.privateState.credentials.token || "";
  if (!/^[\x21-\x7e]{1,16384}$/.test(token))
    throw new Error("Supply a Key Vault audience Bearer access token");
  return token;
}

function targetOf(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): NativeKeyTarget {
  assertTargetInput(input);
  const origin = azureVaultBase(
    input.parameters.vault_url ??
      saved?.configuration.parameters.vault_url ??
      "",
  ).origin;
  const credentials = { token: targetToken(input, saved, origin) };
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
) {
  transport.assertCurrent();
  const base = azureVaultBase(target.parameters.vault_url ?? "");
  const url = new URL(path, base);
  url.searchParams.set("api-version", AZURE_API_VERSION);
  url.searchParams.set("maxresults", "25");
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
  const body = await get(target, transport, "/keys");
  if (
    !isJsonObject(body) ||
    !Array.isArray(body.value) ||
    body.value.length > 100
  )
    throw new NativeApiError("response");
  return body.value.slice(0, 25).map((row) => {
    if (!isJsonObject(row)) throw new NativeApiError("response");
    const kid = isString(row.kid) ? row.kid : "";
    const name = isString(row.name)
      ? row.name
      : kid.split("/").filter(Boolean).at(-1) || "";
    if (!KEY_NAME.test(name)) throw new NativeApiError("response");
    return { id: name, label: safeProviderText(name, target.credentials) };
  });
}

function ui(): NativeKeyUi {
  return {
    name: "Azure Key Vault Keys",
    methodLabel: "Key Vault access token",
    instructions:
      "Supply your vault URL and an issued Bearer access token for the Key Vault audience https://vault.azure.net. Verify and connect lists the first key names without reading key material. Replace an expired token here; no client secret or vault key is stored in the clear.",
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
        label: "Azure Key Vault key permissions",
        url: "https://learn.microsoft.com/en-us/azure/key-vault/keys/about-keys",
      },
    ],
    disconnectExplanation:
      "Disconnect forgets this device's token. It does not revoke the Azure token or change your vault.",
    actions: [
      { id: "provider.keys.read", label: "List key names", fields: [] },
    ],
  };
}

export const azureKeysKeyFlows = createNativeKeyFlows<NativeKeyTarget>({
  family: "Azure Key Vault Keys",
  idPrefix: "conn_azure_keys_",
  accepts,
  classification: { publicParameters: PUBLIC, privateCredentials: PRIVATE },
  ui,
  parse: targetOf,
  fingerprint: async (target) => {
    const encoded = new TextEncoder().encode(
      canonicalize({
        contract: "azure-keys:list:v1",
        parameters: target.parameters,
      }),
    );
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoded))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  },
  prove: async (target, transport) => {
    await names(target, transport);
    const origin = target.parameters.vault_url ?? "";
    return {
      identity: { id: origin, label: new URL(origin).hostname, kind: "vault" },
      targets: [{ id: origin, label: origin, kind: "vault" }],
      grantLabel: "Azure Key Vault key list access",
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
    {
      id: "provider.keys.read",
      inputKeys: [],
      run: async (target, transport) => ({
        label: "First key names",
        items: await names(target, transport),
      }),
    },
  ],
});
