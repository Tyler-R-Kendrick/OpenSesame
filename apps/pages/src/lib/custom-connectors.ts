/** User-owned API key/OAuth connectors. Persist the public definition only. */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { CustomProviderAuth, Provider } from "./connections.js";
import {
  ConnectionsError,
  createCustomProvider,
  deleteCustomProvider,
} from "./connections.js";
import { kvGet, kvSetDurable } from "./kv.js";

const KEY = "custom-connectors.v1";

export type CustomConnectorInput = {
  id: string;
  displayName: string;
  baseUrl: string;
  docsUrl?: string;
  auth: CustomProviderAuth;
};

let cache: CustomConnectorInput[] | null = null;

function parse(raw: string | null): CustomConnectorInput[] {
  if (!raw) return [];
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: CustomConnectorInput[] = [];
    for (const value of parsed) {
      const input = readInput(value);
      if (input) out.push(input);
    }
    return out;
  } catch {
    return [];
  }
}

function readInput(value: BoundaryValue): CustomConnectorInput | null {
  if (!isJsonObject(value)) return null;
  if (
    !isString(value.id) ||
    !isString(value.displayName) ||
    !isString(value.baseUrl) ||
    value.auth === undefined ||
    value.auth === null
  ) {
    return null;
  }
  try {
    httpsOrigin(value.baseUrl);
    const docsUrl = isString(value.docsUrl) ? value.docsUrl : undefined;
    if (docsUrl) httpsOrigin(docsUrl);
    // SAFETY: id/displayName/baseUrl string-checked; auth written only via createCustomProvider.
    const auth = value.auth as CustomProviderAuth;
    const input: CustomConnectorInput = {
      id: value.id,
      displayName: value.displayName,
      baseUrl: value.baseUrl,
      auth,
    };
    if (docsUrl) input.docsUrl = docsUrl;
    return input;
  } catch {
    return null;
  }
}

function httpsOrigin(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("Use an https address.");
  }
  if (url.username || url.password) {
    throw new Error("Do not put credentials in the URL.");
  }
  if (url.search || url.hash) {
    throw new Error("Use an address without query or fragment.");
  }
  return url;
}

function isHostOptionalFailure(error: BoundaryValue): boolean {
  return error instanceof ConnectionsError && error.code === "unreachable";
}

function toProvider(input: CustomConnectorInput): Provider {
  const url = httpsOrigin(input.baseUrl);
  const docs = input.docsUrl ? httpsOrigin(input.docsUrl).href : url.origin;
  return {
    id: input.id,
    displayName: input.displayName,
    category: "custom",
    docsUrl: docs,
    authKind: input.auth.kind,
    supportsRefresh:
      input.auth.kind === "oauth2_authorization_code"
        ? input.auth.supportsRefresh
        : false,
    configured: false,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: {
      scheme: "https",
      authorities: [url.host],
      pathPrefixes: url.pathname === "/" ? [] : [url.pathname],
    },
    operations: [],
  };
}

function load(): CustomConnectorInput[] {
  if (cache) return cache;
  cache = parse(kvGet(KEY));
  return cache;
}

export function listCustomConnectors(): Provider[] {
  return load().map(toProvider);
}

async function persist(next: CustomConnectorInput[]): Promise<void> {
  cache = next;
  await kvSetDurable(KEY, JSON.stringify(next));
}

export const customConnectorSeams = {
  createRemote: createCustomProvider,
  deleteRemote: deleteCustomProvider,
};

export async function addCustomConnector(
  input: CustomConnectorInput,
): Promise<Provider> {
  if (!input.id.startsWith("custom-")) {
    throw new Error("Custom connector IDs start with custom-.");
  }
  if (load().some((row) => row.id === input.id)) {
    throw new Error("A connector with this ID already exists.");
  }
  const provider = toProvider(input);
  await persist([...load(), input]);
  try {
    return await customConnectorSeams.createRemote(input);
  } catch (error) {
    if (isHostOptionalFailure(overlapCast(error))) return provider;
    await persist(load().filter((row) => row.id !== input.id));
    throw error;
  }
}

export async function removeCustomConnector(id: string): Promise<void> {
  try {
    await customConnectorSeams.deleteRemote(id);
  } catch (error) {
    if (!isHostOptionalFailure(overlapCast(error))) throw error;
  }
  await persist(load().filter((row) => row.id !== id));
}

export function mergeCustomConnectors(
  providers: readonly Provider[],
): Provider[] {
  const seen = new Set(providers.map((row) => row.id));
  return [
    ...providers,
    ...listCustomConnectors().filter((row) => !seen.has(row.id)),
  ];
}

/** Tests. */
export function clearCustomConnectors(): void {
  cache = null;
}
