import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { createTypedItem, itemTypeRegistry } from "@opensesame/vault-core";
/**
 * Bring-your-own connections: a method, public endpoint metadata, and one
 * vault item that holds the credential. The connection record never carries a
 * secret; the original stays in the vault under its own sharing policy.
 *
 * The broker/session road is a Host-plane concern. This module establishes the
 * local, browser-owned half: selecting a method, validating its shape, and
 * generating the vault item a broker can later reference.
 */
import type {
  FieldValues,
  ItemTypeDefinition,
} from "@opensesame/vault-item-types";
import type { Connection, Provider } from "./connections.js";
import { readDeviceRows } from "./device-connector-records.js";
import { byoConnectionViewSeams } from "./device-connector-view.js";
import { saveDeviceConnectorConfigurationDurable } from "./device-connectors.js";
import { vaultStore } from "./vault/store.js";

export const BYO_CONNECTION_PROVIDER_ID = "byo-connection";
export const BYO_CONNECTION_ITEM_TYPE_ID = "byo-connection";
export const BYO_CONNECTION_FIELD = "byo_connection";

export type ByoMethod = "oauth" | "basic" | "api-key" | "saml";

export const BYO_METHOD_LABELS = {
  oauth: "OAuth",
  basic: "Basic auth",
  "api-key": "API key",
  saml: "SAML",
} as const satisfies Record<ByoMethod, string>;

export type ByoConnectionInput = {
  name: string;
  service: string;
  method: ByoMethod;
  baseUrl: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  apiKey: string;
  header: string;
  scopes: string;
  samlEntityId: string;
  samlMetadataUrl: string;
  samlMetadataXml: string;
  samlPrivateKey: string;
  refreshToken: string;
};

export type ByoConnectionRecord = {
  itemId: string;
  method: ByoMethod;
  service: string;
  baseUrl: string;
};

/** The synthetic provider row: no catalog file, no credential, no egress. */
export const BYO_CONNECTION_PROVIDER = {
  id: BYO_CONNECTION_PROVIDER_ID,
  displayName: "Custom connection",
  category: "custom",
  docsUrl: null,
  authKind: "configuration",
  supportsRefresh: false,
  configured: true,
  autoConfigurable: false,
  missingConfig: [],
  callbackUrl: null,
  scopes: [],
  egress: { scheme: "none", authorities: [], pathPrefixes: [] },
  operations: [],
  configurationFields: [],
} satisfies Provider;

/**
 * The definition is installed into this vault on first use. It is ordinary
 * manifest data, so every device that receives the item receives the type
 * through the same sealed `itemTypes` record (ADR 0087).
 */
export const BYO_CONNECTION_DEFINITION: ItemTypeDefinition = {
  apiVersion: "opensesame.dev/v1alpha1",
  kind: "VaultItemType",
  metadata: {
    id: BYO_CONNECTION_ITEM_TYPE_ID,
    version: "1.0.0",
    publisher: "https://opensesame.dev",
  },
  spec: {
    title: "Connection",
    plural: "Connections",
    extension: ".byoconn",
    summary:
      "A bring-your-own connection whose credential is held by this vault.",
    categories: ["custom", "access"],
    sections: [
      {
        id: "connection",
        title: "Connection",
        fields: [
          { id: "service", type: "string", label: "Service", required: true },
          {
            id: "method",
            type: "select",
            label: "Method",
            required: true,
            options: ["oauth", "basic", "api-key", "saml"],
          },
          { id: "baseUrl", type: "url", label: "Base URL" },
          { id: "authorizationUrl", type: "url", label: "Authorization URL" },
          { id: "tokenUrl", type: "url", label: "Token URL" },
          { id: "clientId", type: "string", label: "Client ID" },
          { id: "username", type: "string", label: "Username" },
          { id: "credential", type: "concealed", label: "Credential" },
          { id: "header", type: "string", label: "API header" },
          {
            id: "scopes",
            type: "string",
            label: "Scopes",
            multiple: true,
          },
          { id: "samlEntityId", type: "string", label: "SAML entity ID" },
          { id: "samlMetadataUrl", type: "url", label: "SAML metadata URL" },
          {
            id: "samlMetadataXml",
            type: "multiline",
            label: "SAML metadata XML",
          },
          { id: "refreshToken", type: "concealed", label: "Refresh token" },
        ],
      },
    ],
    native: {
      secret: "credential",
      trailer: [
        { key: "service", field: "service" },
        { key: "method", field: "method" },
        { key: "base_url", field: "baseUrl" },
        { key: "authorization_url", field: "authorizationUrl" },
        { key: "token_url", field: "tokenUrl" },
        { key: "client_id", field: "clientId" },
        { key: "username", field: "username" },
        { key: "header", field: "header" },
        { key: "scope", field: "scopes" },
        { key: "saml_entity_id", field: "samlEntityId" },
        { key: "saml_metadata_url", field: "samlMetadataUrl" },
        { key: "saml_metadata_xml", field: "samlMetadataXml" },
        { key: "refresh_token", field: "refreshToken" },
      ],
    },
    cxf: { credential: "custom-fields" },
    subtitle: ["service", "method"],
    search: ["service", "method", "baseUrl", "username", "samlEntityId"],
  },
};

function httpsUrl(value: string): boolean {
  if (/[{}]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname !== "" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function required(value: string): boolean {
  return value.trim() !== "";
}

/** What would stop this connection from being saved. */
export function byoConnectionProblems(input: ByoConnectionInput): string[] {
  const problems: string[] = [];
  if (!required(input.name)) problems.push("Enter a connection name");
  if (!required(input.service)) problems.push("Enter a service name");
  if (!Object.hasOwn(BYO_METHOD_LABELS, input.method))
    problems.push("Choose a supported connection method");
  if (
    input.method !== "saml" &&
    (!required(input.baseUrl) || !httpsUrl(input.baseUrl))
  )
    problems.push("Enter an HTTPS base URL");
  if (input.method === "saml") {
    if (input.baseUrl && !httpsUrl(input.baseUrl))
      problems.push("Base URL must use HTTPS");
    if (!required(input.samlEntityId))
      problems.push("Enter the SAML entity ID");
    if (!required(input.samlMetadataUrl) && !required(input.samlMetadataXml))
      problems.push("Enter SAML metadata URL or XML");
    if (input.samlMetadataUrl && !httpsUrl(input.samlMetadataUrl))
      problems.push("SAML metadata URL must use HTTPS");
    if (input.samlPrivateKey && !required(input.samlPrivateKey))
      problems.push("SAML private key cannot be blank");
  }
  if (input.method === "oauth") {
    if (!httpsUrl(input.authorizationUrl))
      problems.push("Enter an HTTPS authorization URL");
    if (!httpsUrl(input.tokenUrl)) problems.push("Enter an HTTPS token URL");
    if (!required(input.clientId)) problems.push("Enter the OAuth client ID");
  }
  if (input.method === "basic") {
    if (!required(input.username)) problems.push("Enter a username");
    if (!required(input.password)) problems.push("Enter a password");
  }
  if (input.method === "api-key" && !required(input.apiKey))
    problems.push("Enter an API key");
  return problems;
}

function scopes(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/u)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizePem(value: string): string {
  const raw = value.replaceAll(/\r/gu, "").trim();
  if (!raw.includes("-----BEGIN")) return raw;
  const match = /^(-----BEGIN [^-]+-----)([\s\S]+)(-----END [^-]+-----)$/u.exec(
    raw,
  );
  if (!match) return raw;
  const body = (match[2] ?? "").replaceAll(/\s/gu, "");
  const lines = body.match(/.{1,64}/gu)?.join("\n") ?? "";
  return `${match[1] ?? ""}\n${lines}\n${match[3] ?? ""}`;
}

function credentialFor(input: ByoConnectionInput): string {
  if (input.method === "oauth") return input.clientSecret;
  if (input.method === "basic") return input.password;
  if (input.method === "api-key") return input.apiKey;
  return normalizePem(input.samlPrivateKey);
}

function valuesFor(input: ByoConnectionInput): FieldValues {
  return {
    service: input.service.trim(),
    method: input.method,
    baseUrl: input.baseUrl.trim(),
    authorizationUrl: input.authorizationUrl.trim(),
    tokenUrl: input.tokenUrl.trim(),
    clientId: input.clientId.trim(),
    username: input.username.trim(),
    credential: credentialFor(input),
    header: input.header.trim() || "X-Api-Key",
    scopes: scopes(input.scopes),
    samlEntityId: input.samlEntityId.trim(),
    samlMetadataUrl: input.samlMetadataUrl.trim(),
    samlMetadataXml: input.samlMetadataXml,
    refreshToken: input.method === "oauth" ? input.refreshToken : "",
  };
}

function recordFor(
  input: ByoConnectionInput,
  itemId: string,
): ByoConnectionRecord {
  return {
    itemId,
    method: input.method,
    service: input.service.trim(),
    baseUrl: input.baseUrl.trim(),
  };
}

/** The item id a saved connection points at, without reading the secret. */
function isByoMethod(value: string): value is ByoMethod {
  return (
    value === "oauth" ||
    value === "basic" ||
    value === "api-key" ||
    value === "saml"
  );
}

export function readByoConnection(
  connection: Connection | null,
): ByoConnectionRecord | null {
  if (!connection || connection.providerId !== BYO_CONNECTION_PROVIDER_ID)
    return null;
  const row = readDeviceRows().find(
    (entry) => entry.connectionId === connection.connectionId,
  );
  const raw = row?.fields[BYO_CONNECTION_FIELD];
  if (!raw) return null;
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return null;
    const { itemId, method, service, baseUrl } = parsed;
    if (
      !isString(itemId) ||
      !isString(method) ||
      !isString(service) ||
      !isString(baseUrl) ||
      !isByoMethod(method)
    )
      return null;
    return { itemId, method, service, baseUrl };
  } catch {
    return null;
  }
}

byoConnectionViewSeams.itemExists = (itemId) =>
  vaultStore
    .getSnapshot()
    .items.some((item) => item.id === itemId && item.deletedAt === null);

async function ensureDefinition(): Promise<ItemTypeDefinition> {
  const existing = itemTypeRegistry().get(BYO_CONNECTION_ITEM_TYPE_ID);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(BYO_CONNECTION_DEFINITION))
      throw new Error(
        "A different byo-connection type is installed; refusing to store a credential under it.",
      );
    return existing;
  }
  const installed = await vaultStore.installItemTypeDefinition(
    JSON.stringify(BYO_CONNECTION_DEFINITION),
  );
  if (!installed.ok)
    throw new Error(
      `Could not install the connection vault type: ${installed.message}`,
    );
  return installed.definition;
}

/** Test seams: the real ones use the open vault and the device ledger. */
export const byoConnectionSeams = {
  ensureDefinition,
  saveItem: (item: Parameters<typeof vaultStore.saveItem>[0]) =>
    vaultStore.saveItem(item),
  saveConnector: (input: {
    providerId: string;
    displayName: string;
    scopes: string[];
    fields: Record<string, string>;
    secrets: Record<string, string>;
  }) =>
    saveDeviceConnectorConfigurationDurable(() => ({
      providerId: input.providerId,
      displayName: input.displayName,
      scopes: input.scopes,
      fields: input.fields,
      secrets: input.secrets,
    })),
};

/**
 * Save the vault item first, then the public connection record that points to
 * it. A failure after the item write leaves the item in the vault, which is
 * the safe side: the person can still find and share it.
 */
export async function createByoConnection(
  input: ByoConnectionInput,
): Promise<Connection> {
  const problems = byoConnectionProblems(input);
  if (problems.length > 0) throw new Error(problems.join(". "));
  const definition = await byoConnectionSeams.ensureDefinition();
  const item = createTypedItem(definition, valuesFor(input), input.name.trim());
  await byoConnectionSeams.saveItem(item);
  const record = recordFor(input, item.id);
  return byoConnectionSeams.saveConnector({
    providerId: BYO_CONNECTION_PROVIDER_ID,
    displayName: input.name.trim(),
    scopes: scopes(input.scopes),
    fields: { [BYO_CONNECTION_FIELD]: JSON.stringify(record) },
    secrets: {},
  });
}
