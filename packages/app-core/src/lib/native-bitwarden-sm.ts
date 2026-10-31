/**
 * Bitwarden Secrets Manager from a browser (ADR 0218): a service account's own
 * access token, proved by the identity server's client-credentials login, whose
 * encrypted payload only that token can open. The token's last 16 bytes become
 * the key (HKDF over an HMAC, on Web Crypto) that opens the payload, which holds
 * the organization key; secret names and values are EncStrings under it, opened
 * here and nowhere else. Bitwarden's servers answer no web page, so the calls are
 * carried by the connector bridge. The access token never leaves the sealed
 * record, the login's bearer token and the organization key live for one call,
 * and nothing Bitwarden says back in an error is repeated.
 */
import {
  type BoundaryValue,
  canonicalize,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { canonicalProviderId } from "./connector-catalog.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { NativeApiError } from "./native-api-http.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import {
  type BitwardenKey,
  accessTokenKey,
  base64Bytes,
  decryptText,
  symmetricKey,
} from "./native-bitwarden-crypto.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { createNativeKeyFlows } from "./native-key-driver.js";
import { keyCall } from "./native-key-http.js";
import { assertOnlyFields } from "./native-key-input.js";
import type {
  NativeKeyProof,
  NativeKeyTarget,
  NativeKeyUi,
} from "./native-key-types.js";

const SITES = {
  us: {
    identity: "https://identity.bitwarden.com",
    api: "https://api.bitwarden.com",
  },
  eu: {
    identity: "https://identity.bitwarden.eu",
    api: "https://api.bitwarden.eu",
  },
} as const;
type Site = keyof typeof SITES;

const ACCESS_TOKEN = "access_token";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOKEN = new RegExp(
  `^0\\.(${UUID})\\.([A-Za-z0-9]{16,64}):([A-Za-z0-9+/=_-]{22,44})$`,
  "i",
);
const UUID_ONLY = new RegExp(`^${UUID}$`, "i");
const MAX_NAMES = 200;
const MAX_VALUE = 32 * 1024;

export function isNativeBitwardenSecretsProvider(providerId: string): boolean {
  return canonicalProviderId(providerId) === "bitwarden-sm";
}

const siteOf = (value: string | undefined): Site =>
  value === "eu" ? "eu" : "us";

async function digest(parameters: Record<string, string>) {
  const bytes = new TextEncoder().encode(
    canonicalize({ contract: "bitwarden:secrets-manager:v1", parameters }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bitwardenSecretsTarget(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): NativeKeyTarget {
  assertOnlyFields(
    input,
    ["site"],
    [ACCESS_TOKEN],
    "Configure only a region and a service account token",
  );
  const site = input.parameters.site?.trim() || "us";
  if (site !== "us" && site !== "eu") throw new Error("Choose a region");
  const token = (
    input.credentials[ACCESS_TOKEN] ||
    saved?.privateState.credentials[ACCESS_TOKEN] ||
    ""
  ).trim();
  if (!TOKEN.test(token))
    throw new Error("Enter the service account's access token (0.…:…)");
  const credentials = { [ACCESS_TOKEN]: token };
  safeProviderText(input.displayName, credentials);
  safeNativeConnectorIcon(input.icon ?? "", credentials);
  return { providerId: input.providerId, parameters: { site }, credentials };
}

type Session = { bearer: string; organization: string; key: BitwardenKey };

/** The organization claim of the login's bearer token: a UUID, or the login is not one of ours. */
function organizationOf(bearer: string): string {
  const payload = bearer.split(".")[1];
  if (!payload) throw new NativeApiError("response");
  try {
    const claims: BoundaryValue = JSON.parse(
      new TextDecoder().decode(base64Bytes(payload)),
    );
    const organization = isJsonObject(claims) ? claims.organization : undefined;
    if (isString(organization) && UUID_ONLY.test(organization))
      return organization;
  } catch {
    // Not a token this driver reads.
  }
  throw new NativeApiError("response");
}

/** Log in as the service account and open the payload only its token can open. Used for one call. */
async function openSession(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
): Promise<Session> {
  const match = TOKEN.exec(target.credentials[ACCESS_TOKEN] ?? "");
  if (!match) throw new NativeApiError("response");
  const [, id, secret, encodedKey] = match;
  const site = SITES[siteOf(target.parameters.site)];
  const body = await keyCall(
    transport,
    "POST",
    `${site.identity}/connect/token`,
    undefined,
    {
      kind: "form",
      value: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "api.secrets",
        client_id: id ?? "",
        client_secret: secret ?? "",
      }),
    },
    { headers: { "Device-Type": "21" } },
  );
  const bearer = body.access_token;
  const payload = body.encrypted_payload;
  if (
    !isString(bearer) ||
    !/^[A-Za-z0-9._~+/=-]{20,8192}$/.test(bearer) ||
    !isString(payload)
  )
    throw new NativeApiError("response");
  try {
    const opened: BoundaryValue = JSON.parse(
      await decryptText(
        payload,
        await accessTokenKey(base64Bytes(encodedKey ?? "")),
      ),
    );
    const organizationKey = isJsonObject(opened)
      ? opened.encryptionKey
      : undefined;
    if (!isString(organizationKey)) throw new NativeApiError("response");
    return {
      bearer,
      organization: organizationOf(bearer),
      key: symmetricKey(base64Bytes(organizationKey)),
    };
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    // Wrong or tampered payload: the token is not the account's.
    throw new NativeApiError("response");
  }
}

async function names(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
) {
  const session = await openSession(target, transport);
  const site = SITES[siteOf(target.parameters.site)];
  const body = await keyCall(
    transport,
    "GET",
    `${site.api}/organizations/${session.organization}/secrets`,
    session.bearer,
  );
  const list = body.data;
  if (!Array.isArray(list) || list.length > MAX_NAMES * 5)
    throw new NativeApiError("response");
  const items = [];
  for (const row of list.slice(0, MAX_NAMES)) {
    const id = isJsonObject(row) ? row.id : undefined;
    const key = isJsonObject(row) ? row.key : undefined;
    if (!isString(id) || !UUID_ONLY.test(id) || !isString(key))
      throw new NativeApiError("response");
    try {
      const name = await decryptText(key, session.key);
      items.push({
        id,
        label: safeProviderText(name.slice(0, 256), target.credentials),
      });
    } catch (error) {
      if (error instanceof NativeApiError) throw error;
      throw new NativeApiError("response");
    }
  }
  return items;
}

async function value(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  input: Record<string, string>,
) {
  const id = (input.secret ?? "").trim();
  if (!UUID_ONLY.test(id)) throw new Error("Enter a secret ID from the list");
  const session = await openSession(target, transport);
  const site = SITES[siteOf(target.parameters.site)];
  const body = await keyCall(
    transport,
    "GET",
    `${site.api}/secrets/${id}`,
    session.bearer,
  );
  if (body.id !== id || body.organizationId !== session.organization)
    throw new NativeApiError("response");
  const sealed = body.value;
  const label = body.key;
  if (!isString(sealed) || !isString(label))
    throw new NativeApiError("response");
  try {
    const secret = await decryptText(sealed, session.key);
    if (secret.length > MAX_VALUE) throw new NativeApiError("response");
    return {
      id,
      label: safeProviderText(
        (await decryptText(label, session.key)).slice(0, 256),
        target.credentials,
      ),
      secret,
    };
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    throw new NativeApiError("response");
  }
}

export function nativeBitwardenSecretsUi(): NativeKeyUi {
  return {
    name: "Bitwarden Secrets Manager",
    methodLabel: "Service account access token",
    instructions:
      "In Bitwarden open Secrets Manager → Machine accounts, choose a machine account and create an access token. Paste it here. Bitwarden's servers answer no web page, so the calls are carried by the OpenSesame connector bridge; the token proves the account by a login only it can read, secret names and values are decrypted in this browser with Web Crypto, and a value is shown once and never kept.",
    fields: [
      {
        id: "site",
        label: "Region",
        kind: "choice",
        secret: false,
        required: true,
        defaultValue: "us",
        choices: [
          { id: "us", label: "US (bitwarden.com)" },
          { id: "eu", label: "EU (bitwarden.eu)" },
        ],
      },
      {
        id: ACCESS_TOKEN,
        label: "Access token",
        kind: "text",
        secret: true,
        required: true,
        placeholder: "0.…",
      },
    ],
    links: [
      {
        label: "Access tokens",
        url: "https://bitwarden.com/help/access-tokens/",
      },
    ],
    disconnectExplanation:
      "Disconnect forgets this device's access token. It revokes nothing at Bitwarden: revoke the token on the machine account to end its other uses.",
    actions: [
      { id: "provider.names.read", label: "List secret names", fields: [] },
      {
        id: "provider.secret.read",
        label: "Read a secret's value",
        fields: [
          {
            id: "secret",
            label: "Secret ID",
            kind: "text",
            secret: false,
            required: true,
            placeholder: "from the list",
          },
        ],
      },
    ],
  };
}

async function bitwardenSecretsProof(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
): Promise<NativeKeyProof> {
  const session = await openSession(target, transport);
  const site = siteOf(target.parameters.site);
  return {
    identity: {
      id: `organization:${session.organization}`,
      label: "Secrets Manager machine account",
      kind: "machine-account",
    },
    targets: [
      { id: site, label: new URL(SITES[site].api).hostname, kind: "region" },
    ],
    grantLabel: "Bitwarden access token",
    target: { key: "site", id: site },
  };
}

const targetOf = (saved: NativeConnectorRecord): NativeKeyTarget => ({
  providerId: saved.configuration.providerId,
  parameters: saved.configuration.parameters,
  credentials: saved.privateState.credentials,
});

export const bitwardenSecretsKeyFlows = createNativeKeyFlows<NativeKeyTarget>({
  family: "Bitwarden Secrets Manager",
  idPrefix: "conn_bwsm_",
  accepts: isNativeBitwardenSecretsProvider,
  classification: {
    publicParameters: ["site"],
    privateCredentials: [ACCESS_TOKEN],
  },
  ui: nativeBitwardenSecretsUi,
  parse: bitwardenSecretsTarget,
  fingerprint: (target) => digest(target.parameters),
  prove: bitwardenSecretsProof,
  targetOf,
  operations: [
    {
      id: "provider.names.read",
      inputKeys: [],
      run: async (target, transport) => {
        const items = await names(target, transport);
        return { label: `${items.length} secret names`, items };
      },
    },
    {
      id: "provider.secret.read",
      inputKeys: ["secret"],
      run: async (target, transport, input) => {
        const found = await value(target, transport, input);
        return {
          label: "Value read once",
          items: [
            { id: found.id, label: found.label, secretValue: found.secret },
          ],
        };
      },
    },
  ],
});
