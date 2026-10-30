/**
 * Azure App Configuration from a browser (ADR 0198): the person's own store
 * access key, used to sign each request with HMAC-SHA256, sent to the store's
 * own address, compiled from its name and never typed. Verification lists key
 * names, which proves the key may read the store and nothing about its values.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalize } from "@opensesame/os-domain";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { EgressDenied } from "./capabilities/egress.js";
import { canonicalProviderId } from "./connector-catalog.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { NativeApiError } from "./native-api-http.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import { base64ToBytes, bytesToBase64 } from "./native-base64.js";
import { readBoundedText } from "./native-bounded-body.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { createNativeKeyFlows } from "./native-key-driver.js";
import type {
  NativeKeyProof,
  NativeKeyTarget,
  NativeKeyUi,
} from "./native-key-types.js";

const NAME = "Azure App Configuration";
const API = "api-version=2023-11-01";
/** A store name is 5 to 50 letters, digits and hyphens; the address is built from nothing else. */
const STORE = /^[A-Za-z0-9][A-Za-z0-9-]{3,48}[A-Za-z0-9]$/;
const CREDENTIAL = /^[A-Za-z0-9+/=_:-]{4,128}$/;
const SECRET = /^[A-Za-z0-9+/]{16,512}={0,2}$/;
const KEY_NAME = /^[\x20-\x7e\u00a0-\uffff]{1,256}$/;
const MAX_VALUE = 32 * 1024;
const EMPTY_BODY_HASH = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

const PUBLIC = ["store", "access_key_id"];
const PRIVATE = ["access_key_secret"];

export function isNativeAzureAcProvider(providerId: string): boolean {
  return canonicalProviderId(providerId) === "azure-ac";
}

function assertAzureFields(input: NativeApiConfigureInput) {
  if (
    !isNativeAzureAcProvider(input.providerId) ||
    Object.keys(input.requestedScopes ?? {}).length ||
    Object.keys(input.targetIds ?? {}).length ||
    Object.keys(input.parameters).some((key) => !PUBLIC.includes(key)) ||
    Object.keys(input.credentials).some((key) => !PRIVATE.includes(key))
  )
    throw new Error("Configure only an Azure store name and its access key");
}

/** The secret from the form, or the one saved when the form left it blank. */
function azureSecret(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): string {
  const secret =
    input.credentials.access_key_secret ||
    saved?.privateState.credentials.access_key_secret ||
    "";
  if (!SECRET.test(secret) || secret.length % 4 !== 0)
    throw new Error("Enter a valid access key secret");
  return secret;
}

function azureTarget(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): NativeKeyTarget {
  assertAzureFields(input);
  const parameters = {
    store: (input.parameters.store ?? "").trim().toLowerCase(),
    access_key_id: (input.parameters.access_key_id ?? "").trim(),
  };
  if (!STORE.test(parameters.store))
    throw new Error("Enter the store name, not its address");
  if (!CREDENTIAL.test(parameters.access_key_id))
    throw new Error("Enter a valid access key ID");
  const credentials = { access_key_secret: azureSecret(input, saved) };
  safeProviderText(input.displayName, credentials);
  safeNativeConnectorIcon(input.icon ?? "", credentials);
  for (const value of Object.values(parameters))
    safeProviderText(value, credentials);
  return { providerId: input.providerId, parameters, credentials };
}

/** HTTP-date, the form the service's signature names and checks. */
function httpDate(now: Date): string {
  return now.toUTCString();
}

/** One signed GET to the store; the reply is JSON, read bounded, and Azure's own message is never shown. */
async function storeGet(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  pathAndQuery: string,
): Promise<BoundaryValue> {
  transport.assertCurrent();
  const host = `${target.parameters.store}.azconfig.io`;
  const date = httpDate(new Date());
  const signedValues = `${date};${host};${EMPTY_BODY_HASH}`;
  const stringToSign = `GET\n${pathAndQuery}\n${signedValues}`;
  const signature = bytesToBase64(
    hmac(
      sha256,
      base64ToBytes(target.credentials.access_key_secret ?? ""),
      new TextEncoder().encode(stringToSign),
    ),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await transport.fetch(`https://${host}${pathAndQuery}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-ms-date": date,
        "x-ms-content-sha256": EMPTY_BODY_HASH,
        Authorization: `HMAC-SHA256 Credential=${target.parameters.access_key_id}&SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
      },
      signal: controller.signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    transport.assertCurrent();
    if (response.redirected) throw new NativeApiError("response");
    const text = await readBoundedText(response);
    if (response.status === 429) throw new NativeApiError("rate-limit", 429);
    if (response.status === 401) throw new NativeApiError("authorization", 401);
    if (response.status === 403) throw new NativeApiError("permission", 403);
    if (!response.ok) throw new NativeApiError("response", response.status);
    transport.assertCurrent();
    if (controller.signal.aborted) throw new NativeApiError("network");
    const parsed: BoundaryValue = JSON.parse(text);
    if (!isJsonObject(parsed)) throw new NativeApiError("response");
    return parsed;
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    if (error instanceof EgressDenied) throw new NativeApiError("deployment");
    if (error instanceof SyntaxError) throw new NativeApiError("response");
    throw new NativeApiError("network");
  } finally {
    clearTimeout(timeout);
  }
}

/** The first page of key names: bounded, and every name must be one a key can have. */
async function keyNames(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
): Promise<{ id: string; label: string }[]> {
  const body = await storeGet(target, transport, `/keys?${API}`);
  const items = isJsonObject(body) ? body.items : undefined;
  if (!Array.isArray(items) || items.length > 500)
    throw new NativeApiError("response");
  return items.slice(0, 20).map((row) => {
    const name = isJsonObject(row) ? row.name : undefined;
    if (!isString(name) || !KEY_NAME.test(name))
      throw new NativeApiError("response");
    return { id: name, label: safeProviderText(name, target.credentials) };
  });
}

/** One value, read on a person's request and shown once, never kept. */
async function keyValue(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  name: string,
): Promise<string> {
  if (!KEY_NAME.test(name) || name === "." || name === "..")
    throw new Error("Enter a valid key name");
  const body = await storeGet(
    target,
    transport,
    `/kv/${encodeURIComponent(name)}?${API}`,
  );
  const value = isJsonObject(body) ? body.value : undefined;
  if (!isString(value) || value.length > MAX_VALUE)
    throw new NativeApiError("response");
  return value;
}

async function azureProof(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
): Promise<NativeKeyProof> {
  await keyNames(target, transport);
  const store = target.parameters.store ?? "";
  return {
    identity: { id: store, label: `${store}.azconfig.io`, kind: "store" },
    targets: [{ id: store, label: store, kind: "store" }],
    grantLabel: "Azure App Configuration access key",
    target: { key: "store", id: store },
  };
}

export function nativeAzureAcUi(): NativeKeyUi {
  return {
    name: NAME,
    methodLabel: "Store access key",
    instructions:
      "In the Azure portal open the store, then Settings, Access settings, and copy a read-only key's ID and secret. Every request is signed in this browser with HMAC-SHA256 and sent only to the store's own address. Verification lists key names, which proves the key may read the store.",
    fields: [
      {
        id: "store",
        label: "Store name",
        kind: "text",
        secret: false,
        required: true,
        placeholder: "my-store",
      },
      {
        id: "access_key_id",
        label: "Access key ID",
        kind: "text",
        secret: false,
        required: true,
      },
      {
        id: "access_key_secret",
        label: "Access key secret",
        kind: "text",
        secret: true,
        required: true,
      },
    ],
    links: [
      {
        label: "Where to find the access keys",
        url: "https://learn.microsoft.com/en-us/azure/azure-app-configuration/howto-best-practices#security",
      },
    ],
    disconnectExplanation:
      "Disconnect forgets this device's access key. It revokes nothing in Azure: regenerate the key in the portal to end its other uses.",
    actions: [
      { id: "provider.names.read", label: "List key names", fields: [] },
      {
        id: "provider.secret.read",
        label: "Read a key's value",
        fields: [
          {
            id: "name",
            label: "Key",
            kind: "text",
            secret: false,
            required: true,
            placeholder: "app:setting",
          },
        ],
      },
    ],
  };
}

export const azureAcKeyFlows = createNativeKeyFlows<NativeKeyTarget>({
  family: "Azure App Configuration",
  idPrefix: "conn_azac_",
  accepts: isNativeAzureAcProvider,
  classification: { publicParameters: PUBLIC, privateCredentials: PRIVATE },
  ui: nativeAzureAcUi,
  parse: azureTarget,
  fingerprint: async (target) => {
    const bytes = new TextEncoder().encode(
      canonicalize({
        contract: "azure-appconfig:hmac:v1",
        parameters: target.parameters,
      }),
    );
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  },
  prove: azureProof,
  targetOf: (saved) => ({
    providerId: saved.configuration.providerId,
    parameters: saved.configuration.parameters,
    credentials: saved.privateState.credentials,
  }),
  operations: [
    {
      id: "provider.names.read",
      inputKeys: [],
      run: async (target, transport) => {
        const items = await keyNames(target, transport);
        return { label: `First ${items.length} key names`, items };
      },
    },
    {
      id: "provider.secret.read",
      inputKeys: ["name"],
      run: async (target, transport, input) => {
        const name = input.name ?? "";
        const secretValue = await keyValue(target, transport, name);
        return {
          label: "Value read once",
          items: [{ id: name, label: name, secretValue }],
        };
      },
    },
  ],
});
