/**
 * Infisical from a browser (ADR 0199): a machine identity's own client ID and
 * secret, proved by Universal Auth's login, at one of Infisical's two cloud
 * regions. Infisical's servers answer only their own web app's origin, so the
 * call is carried by the connector bridge; the login's answer is the proof,
 * and the access token it returns lives for one call and is never kept.
 * Nothing Infisical says back in an error is repeated.
 */
import { canonicalize } from "@opensesame/os-domain";
import { isJsonObject, isString } from "@opensesame/os-domain";
import { canonicalProviderId } from "./connector-catalog.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { NativeApiError } from "./native-api-http.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { infisicalCall } from "./native-infisical-http.js";
import { createNativeKeyFlows } from "./native-key-driver.js";
import type {
  NativeKeyProof,
  NativeKeyTarget,
  NativeKeyUi,
} from "./native-key-types.js";

const SITES = {
  us: "https://app.infisical.com",
  eu: "https://eu.infisical.com",
} as const;
type Site = keyof typeof SITES;

const CLIENT_ID = "client_id";
const CLIENT_SECRET = "client_secret";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[!-~]{8,512}$/;
const PROJECT = /^[A-Za-z0-9-]{1,64}$/;
const ENVIRONMENT = /^[A-Za-z0-9_-]{1,64}$/;
const FOLDER = /^\/(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?$/;
const SECRET_NAME = /^[A-Za-z0-9_.-]{1,255}$/;
const MAX_NAMES = 200;
const MAX_VALUE = 32 * 1024;

export function isNativeInfisicalProvider(providerId: string): boolean {
  return canonicalProviderId(providerId) === "infisical";
}

const siteOf = (value: string | undefined): Site =>
  value === "eu" ? "eu" : "us";

async function digest(parameters: Record<string, string>) {
  const bytes = new TextEncoder().encode(
    canonicalize({ contract: "infisical:universal-auth:v1", parameters }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A form that asks for a region and a machine identity; nothing more. */
function assertInfisicalFields(input: NativeApiConfigureInput) {
  if (
    Object.keys(input.requestedScopes ?? {}).length ||
    Object.keys(input.targetIds ?? {}).length ||
    Object.keys(input.parameters).some((key) => key !== "site") ||
    Object.keys(input.credentials).some(
      (key) => key !== CLIENT_ID && key !== CLIENT_SECRET,
    )
  )
    throw new Error("Configure only a region and a machine identity");
}

function infisicalTarget(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): NativeKeyTarget {
  assertInfisicalFields(input);
  const site = input.parameters.site?.trim() || "us";
  if (site !== "us" && site !== "eu") throw new Error("Choose a region");
  const kept = saved?.privateState.credentials ?? {};
  const clientId = (
    input.credentials[CLIENT_ID] ||
    kept[CLIENT_ID] ||
    ""
  ).trim();
  const clientSecret = (
    input.credentials[CLIENT_SECRET] ||
    kept[CLIENT_SECRET] ||
    ""
  ).trim();
  if (!UUID.test(clientId))
    throw new Error("Enter the machine identity's client ID");
  if (!SECRET.test(clientSecret)) throw new Error("Enter the client secret");
  const credentials = { [CLIENT_ID]: clientId, [CLIENT_SECRET]: clientSecret };
  safeProviderText(input.displayName, credentials);
  safeNativeConnectorIcon(input.icon ?? "", credentials);
  return { providerId: input.providerId, parameters: { site }, credentials };
}

/** An access token for the saved identity, for exactly one call. */
async function loginToken(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
): Promise<string> {
  const base = SITES[siteOf(target.parameters.site)];
  const body = await infisicalCall(
    transport,
    "POST",
    `${base}/api/v1/auth/universal-auth/login`,
    undefined,
    JSON.stringify({
      clientId: target.credentials[CLIENT_ID] ?? "",
      clientSecret: target.credentials[CLIENT_SECRET] ?? "",
    }),
  );
  const token = body.accessToken;
  if (!isString(token) || !/^[A-Za-z0-9._~+/=-]{20,8192}$/.test(token))
    throw new NativeApiError("response");
  return token;
}

/** The folder a read names: a project, an environment and a path, each in its own shape. */
function where(input: Record<string, string>) {
  const project = (input.project ?? "").trim();
  const environment = (input.environment ?? "").trim() || "prod";
  const path = (input.path ?? "").trim() || "/";
  if (!PROJECT.test(project)) throw new Error("Enter the project ID");
  if (!ENVIRONMENT.test(environment))
    throw new Error("Enter an environment slug");
  if (!FOLDER.test(path) || path.includes(".."))
    throw new Error("Enter a folder path such as /");
  return new URLSearchParams({
    workspaceId: project,
    environment,
    secretPath: path,
  });
}

async function secretNames(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  input: Record<string, string>,
) {
  const query = where(input);
  const token = await loginToken(target, transport);
  const base = SITES[siteOf(target.parameters.site)];
  const body = await infisicalCall(
    transport,
    "GET",
    `${base}/api/v3/secrets/raw?${query}`,
    token,
  );
  const list = body.secrets;
  if (!Array.isArray(list) || list.length > MAX_NAMES * 5)
    throw new NativeApiError("response");
  return list.slice(0, MAX_NAMES).map((row) => {
    const name = isJsonObject(row) ? row.secretKey : undefined;
    if (!isString(name) || !SECRET_NAME.test(name))
      throw new NativeApiError("response");
    return { id: name, label: safeProviderText(name, target.credentials) };
  });
}

async function secretValue(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  input: Record<string, string>,
): Promise<string> {
  const name = (input.name ?? "").trim();
  if (!SECRET_NAME.test(name)) throw new Error("Enter a valid secret name");
  const query = where(input);
  const token = await loginToken(target, transport);
  const base = SITES[siteOf(target.parameters.site)];
  const body = await infisicalCall(
    transport,
    "GET",
    `${base}/api/v3/secrets/raw/${encodeURIComponent(name)}?${query}`,
    token,
  );
  const secret = isJsonObject(body.secret)
    ? body.secret.secretValue
    : undefined;
  if (!isString(secret) || secret.length > MAX_VALUE)
    throw new NativeApiError("response");
  return secret;
}

const FOLDER_FIELDS = [
  {
    id: "project",
    label: "Project ID",
    kind: "text",
    secret: false,
    required: true,
    placeholder: "00000000-0000-0000-0000-000000000000",
  },
  {
    id: "environment",
    label: "Environment",
    kind: "text",
    secret: false,
    required: false,
    placeholder: "prod",
  },
  {
    id: "path",
    label: "Folder",
    kind: "text",
    secret: false,
    required: false,
    placeholder: "/",
  },
] as const;

export function nativeInfisicalUi(): NativeKeyUi {
  return {
    name: "Infisical",
    methodLabel: "Machine identity",
    instructions:
      "In Infisical open Organization Settings → Access Control → Machine Identities, create an identity with Universal Auth, and add a client secret. Paste its client ID and client secret. Infisical's servers answer only its own web app, so the call is carried by the OpenSesame connector bridge; the login proves the identity and the token it returns is used once and not kept.",
    fields: [
      {
        id: "site",
        label: "Region",
        kind: "choice",
        secret: false,
        required: true,
        defaultValue: "us",
        choices: [
          { id: "us", label: "US (app.infisical.com)" },
          { id: "eu", label: "EU (eu.infisical.com)" },
        ],
      },
      {
        id: CLIENT_ID,
        label: "Client ID",
        kind: "text",
        secret: true,
        required: true,
        placeholder: "00000000-0000-0000-0000-000000000000",
      },
      {
        id: CLIENT_SECRET,
        label: "Client secret",
        kind: "text",
        secret: true,
        required: true,
      },
    ],
    links: [
      {
        label: "Universal Auth",
        url: "https://infisical.com/docs/documentation/platform/identities/universal-auth",
      },
    ],
    disconnectExplanation:
      "Disconnect forgets this device's client ID and secret. It revokes nothing at Infisical: delete the client secret on the identity to end its other uses.",
    actions: [
      {
        id: "provider.names.read",
        label: "List secret names",
        fields: FOLDER_FIELDS,
      },
      {
        id: "provider.secret.read",
        label: "Read a secret's value",
        fields: [
          ...FOLDER_FIELDS,
          {
            id: "name",
            label: "Secret name",
            kind: "text",
            secret: false,
            required: true,
            placeholder: "DATABASE_URL",
          },
        ],
      },
    ],
  };
}

async function infisicalProof(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
): Promise<NativeKeyProof> {
  await loginToken(target, transport);
  const site = siteOf(target.parameters.site);
  const host = new URL(SITES[site]).hostname;
  return {
    identity: { id: host, label: "Machine identity", kind: "machine-identity" },
    targets: [{ id: site, label: host, kind: "region" }],
    grantLabel: "Infisical machine identity",
    target: { key: "site", id: site },
  };
}

const targetOf = (saved: NativeConnectorRecord): NativeKeyTarget => ({
  providerId: saved.configuration.providerId,
  parameters: saved.configuration.parameters,
  credentials: saved.privateState.credentials,
});

export const infisicalKeyFlows = createNativeKeyFlows<NativeKeyTarget>({
  family: "Infisical",
  idPrefix: "conn_infisical_",
  accepts: isNativeInfisicalProvider,
  classification: {
    publicParameters: ["site"],
    privateCredentials: [CLIENT_ID, CLIENT_SECRET],
  },
  ui: nativeInfisicalUi,
  parse: infisicalTarget,
  fingerprint: (target) => digest(target.parameters),
  prove: infisicalProof,
  targetOf,
  operations: [
    {
      id: "provider.names.read",
      inputKeys: ["project", "environment", "path"],
      run: async (target, transport, input) => {
        const items = await secretNames(target, transport, input);
        return { label: `First ${items.length} names`, items };
      },
    },
    {
      id: "provider.secret.read",
      inputKeys: ["project", "environment", "path", "name"],
      run: async (target, transport, input) => {
        const name = (input.name ?? "").trim();
        return {
          label: "Value read once",
          items: [
            {
              id: name,
              label: name,
              secretValue: await secretValue(target, transport, input),
            },
          ],
        };
      },
    },
  ],
});
