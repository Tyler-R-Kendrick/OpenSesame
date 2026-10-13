/**
 * Google Cloud Secret Manager and IAM Credentials from a browser (ADR 0198):
 * the person's own service-account key signs a JWT in this page, Google
 * answers with an access token that lives for one call, and the API is called
 * at its own address. Verification is a real call, so it proves the key signs
 * and, for Secret Manager, may list names. Nothing Google says back is shown.
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
import { base64ToBytes } from "./native-base64.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  gcpAccessToken,
  isGcpProjectId,
  isGcpServiceAccountEmail,
  parseGcpServiceAccount,
} from "./native-gcp-auth.js";
import { gcpApiCall } from "./native-gcp-http.js";
import { createNativeKeyFlows } from "./native-key-driver.js";
import type {
  NativeKeyProof,
  NativeKeyTarget,
  NativeKeyUi,
} from "./native-key-types.js";

const KEY = "service_account_json";
const SECRET_NAME = /^[A-Za-z0-9_-]{1,255}$/;
const MAX_VALUE = 32 * 1024;

export function isNativeGcpProvider(providerId: string): boolean {
  return canonicalProviderId(providerId) === "gcp";
}

export function isNativeGcpIamProvider(providerId: string): boolean {
  return canonicalProviderId(providerId) === "gcp-iam";
}

async function digest(contract: string, parameters: Record<string, string>) {
  const bytes = new TextEncoder().encode(
    canonicalize({ contract, parameters }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The key file, whole, from the form or from what was saved when the form left it blank. */
function keyText(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
) {
  return input.credentials[KEY] || saved?.privateState.credentials[KEY] || "";
}

/** A form that asks for a key file and, for Secret Manager, a project; nothing more. */
function assertGcpFields(input: NativeApiConfigureInput, withProject: boolean) {
  const allowed = withProject ? ["project"] : [];
  if (
    Object.keys(input.requestedScopes ?? {}).length ||
    Object.keys(input.targetIds ?? {}).length ||
    Object.keys(input.parameters).some((key) => !allowed.includes(key)) ||
    Object.keys(input.credentials).some((key) => key !== KEY)
  )
    throw new Error("Configure only a service account key and its project");
}

function gcpTarget(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
  withProject: boolean,
): NativeKeyTarget {
  assertGcpFields(input, withProject);
  const account = parseGcpServiceAccount(keyText(input, saved));
  const project =
    (input.parameters.project ?? "").trim() || account.projectId || "";
  if (withProject && !isGcpProjectId(project))
    throw new Error("Enter the project ID");
  const entries: [string, string][] = [["client_email", account.clientEmail]];
  if (withProject) entries.push(["project", project]);
  const parameters = Object.fromEntries(entries);
  const credentials = { [KEY]: keyText(input, saved) };
  safeProviderText(input.displayName, credentials);
  safeNativeConnectorIcon(input.icon ?? "", credentials);
  for (const value of Object.values(parameters))
    safeProviderText(value, credentials);
  return { providerId: input.providerId, parameters, credentials };
}

/** An access token for the saved key, for exactly one call. */
function tokenFor(target: NativeKeyTarget, transport: NativeProviderTransport) {
  return gcpAccessToken(
    parseGcpServiceAccount(target.credentials[KEY] ?? ""),
    transport,
  );
}

async function secretNames(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
) {
  const token = await tokenFor(target, transport);
  const project = target.parameters.project ?? "";
  const body = await gcpApiCall(
    transport,
    token,
    "GET",
    `https://secretmanager.googleapis.com/v1/projects/${project}/secrets?pageSize=20`,
  );
  // A project with no secrets answers with no list at all.
  const list = body.secrets ?? [];
  if (!Array.isArray(list) || list.length > 100)
    throw new NativeApiError("response");
  return list.map((row) => {
    const full = isJsonObject(row) ? row.name : undefined;
    const name = isString(full) ? full.split("/").pop() : undefined;
    if (!name || !SECRET_NAME.test(name)) throw new NativeApiError("response");
    return { id: name, label: safeProviderText(name, target.credentials) };
  });
}

async function secretValue(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  name: string,
): Promise<string> {
  if (!SECRET_NAME.test(name)) throw new Error("Enter a valid secret name");
  const token = await tokenFor(target, transport);
  const project = target.parameters.project ?? "";
  const body = await gcpApiCall(
    transport,
    token,
    "GET",
    `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}/versions/latest:access`,
  );
  const payload = isJsonObject(body.payload) ? body.payload.data : undefined;
  if (!isString(payload) || payload.length > MAX_VALUE * 2)
    throw new NativeApiError("response");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      base64ToBytes(payload),
    );
    if (text.length > MAX_VALUE) throw new NativeApiError("response");
    return text;
  } catch (error) {
    // A binary secret has no honest text to show.
    if (error instanceof NativeApiError) throw error;
    throw new NativeApiError("response");
  }
}

const KEY_FIELD_UI = {
  id: KEY,
  label: "Service account key (JSON)",
  kind: "text",
  secret: true,
  required: true,
  placeholder: '{"type":"service_account", …}',
} as const;

const KEY_LINK = {
  label: "Create a service account key",
  url: "https://cloud.google.com/iam/docs/keys-create-delete",
};

const DISCONNECT =
  "Disconnect forgets this device's service account key. It revokes nothing at Google: delete the key in the console to end its other uses.";

export function nativeGcpUi(): NativeKeyUi {
  return {
    name: "Google Cloud Secret Manager",
    methodLabel: "Service account key",
    instructions:
      "Create a service account with the Secret Manager Secret Accessor role (and Viewer to list names), add a JSON key and paste it. The key signs a short-lived token in this browser and is sent only to Google's own token and API addresses. Verification lists the first secret names.",
    fields: [
      {
        id: "project",
        label: "Project ID (optional)",
        kind: "text",
        secret: false,
        required: false,
        placeholder: "defaults to the key's own project",
      },
      KEY_FIELD_UI,
    ],
    links: [KEY_LINK],
    disconnectExplanation: DISCONNECT,
    actions: [
      { id: "provider.names.read", label: "List secret names", fields: [] },
      {
        id: "provider.secret.read",
        label: "Read a secret's latest value",
        fields: [
          {
            id: "name",
            label: "Secret name",
            kind: "text",
            secret: false,
            required: true,
            placeholder: "database-password",
          },
        ],
      },
    ],
  };
}

async function gcpProof(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
): Promise<NativeKeyProof> {
  await secretNames(target, transport);
  const project = target.parameters.project ?? "";
  return {
    identity: {
      id: target.parameters.client_email ?? "",
      label: target.parameters.client_email ?? "",
      kind: "service-account",
    },
    targets: [{ id: project, label: project, kind: "project" }],
    grantLabel: "Google service account key",
    target: { key: "project", id: project },
  };
}

const targetOf = (saved: NativeConnectorRecord): NativeKeyTarget => ({
  providerId: saved.configuration.providerId,
  parameters: saved.configuration.parameters,
  credentials: saved.privateState.credentials,
});

export const gcpKeyFlows = createNativeKeyFlows<NativeKeyTarget>({
  family: "Google Cloud Secret Manager",
  idPrefix: "conn_gcp_",
  accepts: isNativeGcpProvider,
  classification: {
    publicParameters: ["project", "client_email"],
    privateCredentials: [KEY],
  },
  ui: nativeGcpUi,
  parse: (input, saved) => gcpTarget(input, saved, true),
  fingerprint: (target) =>
    digest("gcp:jwt-bearer:secretmanager:v1", target.parameters),
  prove: gcpProof,
  targetOf,
  operations: [
    {
      id: "provider.names.read",
      inputKeys: [],
      run: async (target, transport) => {
        const items = await secretNames(target, transport);
        return { label: `First ${items.length} names`, items };
      },
    },
    {
      id: "provider.secret.read",
      inputKeys: ["name"],
      run: async (target, transport, input) => {
        const name = input.name ?? "";
        return {
          label: "Value read once",
          items: [
            {
              id: name,
              label: name,
              secretValue: await secretValue(target, transport, name),
            },
          ],
        };
      },
    },
  ],
});

/** Short-lived credentials for a service account the key may impersonate, shown once. */
async function generateAccessToken(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  serviceAccount: string,
) {
  if (!isGcpServiceAccountEmail(serviceAccount))
    throw new Error("Enter a service account email");
  const token = await tokenFor(target, transport);
  const body = await gcpApiCall(
    transport,
    token,
    "POST",
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateAccessToken`,
    JSON.stringify({
      scope: ["https://www.googleapis.com/auth/cloud-platform"],
      lifetime: "3600s",
    }),
  );
  const access = body.accessToken;
  const expires = body.expireTime;
  if (
    !isString(access) ||
    !/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(access) ||
    !isString(expires) ||
    !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(expires)
  )
    throw new NativeApiError("response");
  return {
    label: "Access token, shown once",
    items: [
      { id: "accessToken", label: "Access token", secretValue: access },
      { id: "expireTime", label: `Expires ${expires}` },
    ],
  };
}

export function nativeGcpIamUi(): NativeKeyUi {
  return {
    name: "Google Cloud IAM Credentials",
    methodLabel: "Service account key",
    instructions:
      "Paste a service account JSON key. It signs a short-lived token in this browser, and Google's IAM Credentials API can then issue an access token for a service account the key may impersonate (the Service Account Token Creator role). Verification checks that Google accepts the key.",
    fields: [KEY_FIELD_UI],
    links: [
      KEY_LINK,
      {
        label: "Create short-lived credentials",
        url: "https://cloud.google.com/iam/docs/create-short-lived-credentials-direct",
      },
    ],
    disconnectExplanation: DISCONNECT,
    actions: [
      {
        id: "gcp.access-token.generate",
        label: "Get an access token for a service account",
        fields: [
          {
            id: "service_account",
            label: "Service account email",
            kind: "text",
            secret: false,
            required: true,
            placeholder: "target@project.iam.gserviceaccount.com",
          },
        ],
      },
    ],
  };
}

export const gcpIamKeyFlows = createNativeKeyFlows<NativeKeyTarget>({
  family: "Google Cloud IAM Credentials",
  idPrefix: "conn_gcpiam_",
  accepts: isNativeGcpIamProvider,
  classification: {
    publicParameters: ["client_email"],
    privateCredentials: [KEY],
  },
  ui: nativeGcpIamUi,
  parse: (input, saved) => gcpTarget(input, saved, false),
  fingerprint: (target) =>
    digest("gcp:jwt-bearer:iamcredentials:v1", target.parameters),
  prove: async (target, transport) => {
    await tokenFor(target, transport);
    const email = target.parameters.client_email ?? "";
    return {
      identity: { id: email, label: email, kind: "service-account" },
      targets: [{ id: email, label: email, kind: "service-account" }],
      grantLabel: "Google service account key",
      target: { key: "service_account", id: email },
    };
  },
  targetOf,
  operations: [
    {
      id: "gcp.access-token.generate",
      inputKeys: ["service_account"],
      run: (target, transport, input) =>
        generateAccessToken(target, transport, input.service_account ?? ""),
    },
  ],
});
