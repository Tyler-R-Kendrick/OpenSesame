/**
 * Tailscale from a browser (ADR 0218): the person's own API access token, or an
 * OAuth client's ID and secret exchanged for a short-lived token, against
 * Tailscale's cloud API. `api.tailscale.com` answers no web page, so the call
 * is carried by the connector bridge. The credential is proved by reading the
 * tailnet's devices; an OAuth token lives for one call and is never kept, and
 * nothing Tailscale says back in an error is repeated.
 */
import { canonicalize } from "@opensesame/os-domain";
import { canonicalProviderId } from "./connector-catalog.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { createNativeKeyFlows } from "./native-key-driver.js";
import { assertOnlyFields } from "./native-key-input.js";
import type { NativeKeyProof, NativeKeyTarget } from "./native-key-types.js";
import {
  HOSTNAME,
  TOKEN,
  authKeys,
  call,
  createAuthKey,
  deviceId,
  devices,
} from "./native-tailscale-api.js";
import {
  API_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  nativeTailscaleUi,
} from "./native-tailscale-ui.js";

const OAUTH_ID = /^[A-Za-z0-9]{6,64}$/;
const OAUTH_SECRET = /^[!-~]{8,512}$/;
const TAILNET = /^(?:-|[A-Za-z0-9][A-Za-z0-9.-]{0,254})$/;

export function isNativeTailscaleProvider(providerId: string): boolean {
  return canonicalProviderId(providerId) === "tailscale";
}

async function digest(target: NativeKeyTarget) {
  const flavor = target.credentials[API_TOKEN] ? "token" : "oauth";
  const bytes = new TextEncoder().encode(
    canonicalize({
      contract: "tailscale:api:v1",
      flavor,
      parameters: target.parameters,
    }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Exactly one credential: an API access token, or an OAuth client's ID and secret. */
function tailscaleCredentials(
  token: string,
  clientId: string,
  clientSecret: string,
): NativeKeyTarget["credentials"] {
  if (token && !clientId && !clientSecret) {
    if (!TOKEN.test(token))
      throw new Error("Enter a Tailscale API access token (tskey-api-…)");
    return { [API_TOKEN]: token };
  }
  if (!token && clientId && clientSecret) {
    if (!OAUTH_ID.test(clientId))
      throw new Error("Enter the OAuth client's ID");
    if (!OAUTH_SECRET.test(clientSecret))
      throw new Error("Enter the OAuth client's secret");
    return { [CLIENT_ID]: clientId, [CLIENT_SECRET]: clientSecret };
  }
  throw new Error(
    "Enter either an API access token or an OAuth client's ID and secret",
  );
}

function tailscaleTarget(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): NativeKeyTarget {
  assertOnlyFields(
    input,
    ["tailnet"],
    [API_TOKEN, CLIENT_ID, CLIENT_SECRET],
    "Configure only a tailnet and one Tailscale credential",
  );
  const tailnet = input.parameters.tailnet?.trim() || "-";
  if (!TAILNET.test(tailnet)) throw new Error("Enter a tailnet name, or -");
  const kept = saved?.privateState.credentials ?? {};
  // Supplying one kind of credential replaces the other kind: it is never
  // restored beside it. An OAuth client's missing half may still be kept.
  const bringsToken = Boolean(input.credentials[API_TOKEN]);
  const bringsClient = Boolean(
    input.credentials[CLIENT_ID] || input.credentials[CLIENT_SECRET],
  );
  const restoreToken = !bringsClient;
  const restoreClient = !bringsToken;
  const pick = (name: string, restore: boolean) =>
    (input.credentials[name] || (restore ? kept[name] : "") || "").trim();
  const token = pick(API_TOKEN, restoreToken);
  const clientId = pick(CLIENT_ID, restoreClient);
  const clientSecret = pick(CLIENT_SECRET, restoreClient);
  const credentials = tailscaleCredentials(token, clientId, clientSecret);
  safeProviderText(input.displayName, credentials);
  safeNativeConnectorIcon(input.icon ?? "", credentials);
  return { providerId: input.providerId, parameters: { tailnet }, credentials };
}

/** The bearer token for exactly one call: the access token itself, or one minted from the OAuth client. */

async function tailscaleProof(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
): Promise<NativeKeyProof> {
  const found = await devices(target, transport);
  const tailnet = target.parameters.tailnet || "-";
  return {
    identity: {
      id: `tailnet:${tailnet}`,
      label: tailnet === "-" ? "Your tailnet" : tailnet,
      kind: "tailnet",
    },
    targets: [
      {
        id: tailnet,
        label: `${tailnet === "-" ? "Your tailnet" : tailnet} · ${found.length} device${found.length === 1 ? "" : "s"}`,
        kind: "tailnet",
      },
    ],
    grantLabel: "Tailscale credential",
    target: { key: "tailnet", id: tailnet },
  };
}

const targetOf = (saved: NativeConnectorRecord): NativeKeyTarget => ({
  providerId: saved.configuration.providerId,
  parameters: saved.configuration.parameters,
  credentials: saved.privateState.credentials,
});

export const tailscaleKeyFlows = createNativeKeyFlows<NativeKeyTarget>({
  family: "Tailscale",
  idPrefix: "conn_tailscale_",
  accepts: isNativeTailscaleProvider,
  classification: {
    publicParameters: ["tailnet"],
    privateCredentials: [API_TOKEN, CLIENT_ID, CLIENT_SECRET],
  },
  ui: nativeTailscaleUi,
  parse: tailscaleTarget,
  fingerprint: digest,
  prove: tailscaleProof,
  targetOf,
  operations: [
    {
      id: "provider.devices.read",
      inputKeys: [],
      run: async (target, transport) => {
        const items = await devices(target, transport);
        return { label: `${items.length} devices`, items };
      },
    },
    {
      id: "provider.device.authorize",
      inputKeys: ["device"],
      run: async (target, transport, input) => {
        const id = deviceId(input);
        await call(target, transport, "POST", `/device/${id}/authorized`, {
          kind: "json",
          value: { authorized: true },
        });
        return {
          label: "Approved",
          items: [{ id: decodeURIComponent(id), label: "Device approved" }],
        };
      },
    },
    {
      id: "provider.device.rename",
      inputKeys: ["device", "name"],
      run: async (target, transport, input) => {
        const id = deviceId(input);
        const name = (input.name ?? "").trim();
        if (!HOSTNAME.test(name))
          throw new Error("Enter a name of letters, digits and hyphens");
        await call(target, transport, "POST", `/device/${id}/name`, {
          kind: "json",
          value: { name },
        });
        return {
          label: "Renamed",
          items: [{ id: decodeURIComponent(id), label: name }],
        };
      },
    },
    {
      id: "provider.keys.read",
      inputKeys: [],
      run: async (target, transport) => {
        const items = await authKeys(target, transport);
        return { label: `${items.length} auth keys`, items };
      },
    },
    {
      id: "provider.key.create",
      inputKeys: ["tags", "reusable", "ephemeral", "expiry_days"],
      run: async (target, transport, input) => {
        const made = await createAuthKey(target, transport, input);
        return {
          label: "Key shown once",
          items: [
            {
              id: made.id,
              label: `Auth key ${made.id}`,
              secretValue: made.key,
            },
          ],
        };
      },
    },
  ],
});
