/**
 * A Bitwarden or Vaultwarden vault from a browser (ADR 0217): the account's own
 * personal API key logs in without a device-approval email or a second step,
 * and the master password, which never leaves this device, derives the key
 * (PBKDF2-SHA256 or Argon2id, then HKDF) that opens the vault key, which opens
 * each item. Everything is Web Crypto; Bitwarden's servers answer no web page,
 * so the calls are carried by the connector bridge. A self-hosted Vaultwarden
 * is reached directly, and works when the instance admits this site. Only
 * personal items are read; the vault's encrypted data must fit the bridge's
 * 1 MiB answer. Nothing Bitwarden says back in an error is repeated.
 */
import { canonicalize } from "@opensesame/os-domain";
import { canonicalProviderId } from "./connector-catalog.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import {
  API_CLIENT_ID,
  CLIENT_ID,
  CLIENT_SECRET,
  EMAIL,
  PASSWORD,
  names,
  openVault,
  secretOf,
  servers,
} from "./native-bitwarden-vault-api.js";
import {
  isSelfHosted,
  nativeBitwardenVaultUi,
} from "./native-bitwarden-vault-ui.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { createNativeKeyFlows } from "./native-key-driver.js";
import { assertOnlyFields } from "./native-key-input.js";
import type { NativeKeyProof, NativeKeyTarget } from "./native-key-types.js";

const SECRET = /^[A-Za-z0-9]{16,64}$/;
const ADDRESS = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export function isNativeBitwardenVaultProvider(providerId: string): boolean {
  const id = canonicalProviderId(providerId);
  return id === "bitwarden" || id === "vaultwarden";
}

async function digest(target: NativeKeyTarget) {
  const bytes = new TextEncoder().encode(
    canonicalize({
      contract: "bitwarden:vault:v1",
      provider: canonicalProviderId(target.providerId),
      parameters: target.parameters,
    }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A Vaultwarden address: HTTPS, no credentials, query or fragment; the origin and path it is served at. */
function serverAddress(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      "Enter your Vaultwarden address, such as https://vault.example.com",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Enter your Vaultwarden address, such as https://vault.example.com",
    );
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function vaultParameters(
  input: NativeApiConfigureInput,
  hosted: boolean,
): NativeKeyTarget["parameters"] {
  if (hosted) return { server: serverAddress(input.parameters.server ?? "") };
  const site = input.parameters.site?.trim() || "us";
  if (site !== "us" && site !== "eu") throw new Error("Choose a region");
  return { site };
}

function vaultCredentials(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): NativeKeyTarget["credentials"] {
  const kept = saved?.privateState.credentials ?? {};
  const pick = (name: string) =>
    (input.credentials[name] || kept[name] || "").trim();
  const email = pick(EMAIL).toLowerCase();
  const password = input.credentials[PASSWORD] || kept[PASSWORD] || "";
  const clientId = pick(CLIENT_ID);
  const clientSecret = pick(CLIENT_SECRET);
  if (!ADDRESS.test(email))
    throw new Error("Enter the account's email address");
  if (password.length < 1 || password.length > 1024)
    throw new Error("Enter the master password");
  if (!API_CLIENT_ID.test(clientId))
    throw new Error("Enter the personal API key's client ID (user.…)");
  if (!SECRET.test(clientSecret))
    throw new Error("Enter the personal API key's client secret");
  return {
    [EMAIL]: email,
    [PASSWORD]: password,
    [CLIENT_ID]: clientId,
    [CLIENT_SECRET]: clientSecret,
  };
}

function bitwardenVaultTarget(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): NativeKeyTarget {
  const hosted = isSelfHosted(input.providerId);
  const allowed = hosted ? "server" : "site";
  assertOnlyFields(
    input,
    [allowed],
    [EMAIL, PASSWORD, CLIENT_ID, CLIENT_SECRET],
    "Configure only the server and the account's credentials",
  );
  const parameters = vaultParameters(input, hosted);
  const credentials = vaultCredentials(input, saved);
  safeProviderText(input.displayName, credentials);
  safeNativeConnectorIcon(input.icon ?? "", credentials);
  return { providerId: input.providerId, parameters, credentials };
}

async function bitwardenVaultProof(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
): Promise<NativeKeyProof> {
  await openVault(target, transport);
  const key = target.parameters.server ? "server" : "site";
  const id = target.parameters.server ?? target.parameters.site ?? "us";
  return {
    identity: {
      id: `${id}:${target.credentials[CLIENT_ID]}`,
      label: "Vault account",
      kind: "vault-account",
    },
    targets: [
      { id, label: new URL(servers(target).api).hostname, kind: "server" },
    ],
    grantLabel: "Bitwarden API key",
    target: { key, id },
  };
}

const targetOf = (saved: NativeConnectorRecord): NativeKeyTarget => ({
  providerId: saved.configuration.providerId,
  parameters: saved.configuration.parameters,
  credentials: saved.privateState.credentials,
});

export const bitwardenVaultKeyFlows = createNativeKeyFlows<NativeKeyTarget>({
  family: "Bitwarden",
  idPrefix: "conn_bwvault_",
  accepts: isNativeBitwardenVaultProvider,
  classification: {
    publicParameters: ["site", "server"],
    privateCredentials: [EMAIL, PASSWORD, CLIENT_ID, CLIENT_SECRET],
  },
  ui: nativeBitwardenVaultUi,
  parse: bitwardenVaultTarget,
  fingerprint: digest,
  prove: bitwardenVaultProof,
  targetOf,
  operations: [
    {
      id: "provider.names.read",
      inputKeys: [],
      run: async (target, transport) => {
        const items = await names(target, transport);
        return { label: `${items.length} items`, items };
      },
    },
    {
      id: "provider.item.read",
      inputKeys: ["item"],
      run: async (target, transport, input) => {
        const found = await secretOf(target, transport, input);
        return {
          label: "Read once",
          items: [
            { id: found.id, label: found.label, secretValue: found.value },
          ],
        };
      },
    },
  ],
});
