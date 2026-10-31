/** Provider-owned request definitions consume one verified saved credential. */
import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { connectPlan } from "./connect-plan.js";
import {
  nativeApiExposedCredentials,
  nativeApiHeaders,
  nativeApiOperationUrl,
} from "./native-api-auth.js";
import { assertNativeApiAuthority } from "./native-api-authority.js";
import {
  NativeApiError,
  type NativeApiHttpRequest,
  nativeApiHttp,
} from "./native-api-http.js";
import {
  invalidateNativeApiProof,
  requireNativeApiBrowserAccess,
} from "./native-api-proof.js";
import {
  type NativeApiTarget,
  nativeApiFingerprint,
  nativeApiTarget,
  providerUrl,
} from "./native-api-target.js";
import { safeProviderText } from "./native-api-verify.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
  loadNativeConnectorRecord,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";

export type NativeApiOperationDefinition = {
  providerId: string;
  operationId: string;
  method: "GET" | "POST";
  /** Fixed trusted route, relative to the compiled credential prefix if any. */
  path: string;
  /** Trusted driver fields, not a raw query string or unclassified UI input. */
  query?: Readonly<Record<string, string | number | boolean>>;
  origin?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Called once, just before a request can leave; nothing thrown before it was sent. */
  onDispatch?: () => void;
};
function safeProjection(
  value: BoundaryValue,
  credentials: Record<string, string>,
  depth = 0,
): void {
  if (depth > 10) throw new NativeApiError("response");
  if (isString(value)) {
    if (value.length > 65536) throw new NativeApiError("response");
    for (const secret of Object.values(credentials))
      if (secret && value.includes(secret))
        throw new NativeApiError("response");
  } else if (Array.isArray(value)) {
    if (value.length > 100) throw new NativeApiError("response");
    for (const item of value) safeProjection(item, credentials, depth + 1);
  } else if (isJsonObject(value)) {
    if (Object.keys(value).length > 100) throw new NativeApiError("response");
    for (const [key, item] of Object.entries(value)) {
      safeProviderText(key, credentials);
      safeProjection(item, credentials, depth + 1);
    }
  }
}
function verifiedOperationRecord(
  id: string,
  definition: NativeApiOperationDefinition,
): NativeConnectorRecord {
  const record = loadNativeConnectorRecord(id);
  if (
    !record ||
    record.configuration.method !== "api-key" ||
    record.configuration.providerId !== definition.providerId
  )
    throw new Error(
      "Use a verified saved API-key connection for this provider",
    );
  return record;
}
function operationRequest(
  record: NativeConnectorRecord,
  target: NativeApiTarget,
  definition: NativeApiOperationDefinition,
) {
  const verify = target.profile.verify;
  if (!verify) throw new Error("Provider verification is unavailable");
  const verifiedOrigin = providerUrl(
    verify.url,
    target,
    record.privateState.credentials,
  ).origin;
  const allowed = connectPlan(definition.providerId)?.methods.find(
    (method) => method.kind === "api-key",
  );
  const origin = definition.origin ?? verifiedOrigin;
  const origins =
    origin !== verifiedOrigin && allowed?.kind === "api-key"
      ? (allowed.preset?.serviceUrls ?? []).map(
          (url) => providerUrl(url, target, {}).origin,
        )
      : [];
  if (
    (origin !== verifiedOrigin && !origins.includes(origin)) ||
    new URL(origin).origin !== origin
  )
    throw new Error("Provider operation does not match its compiled target");
  const credentials = record.privateState.credentials;
  const exposed = nativeApiExposedCredentials(target, credentials);
  safeProjection(definition.path, exposed);
  assertOperationPath(definition.path);
  const url = new URL(definition.path, origin);
  if (url.origin !== origin || url.pathname !== definition.path)
    throw new Error("Provider operation changed its target");
  operationQuery(url, definition.query, exposed);
  const headers = operationHeaders(record, target, definition);
  return { url: nativeApiOperationUrl(target, credentials, url), headers };
}
function hasOperationControls(value: string, minimum = 32): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < minimum || code === 127;
  });
}
function assertOperationPath(path: string): void {
  if (
    path.length > 2048 ||
    !path.startsWith("/") ||
    /[?#\\]/.test(path) ||
    hasOperationControls(path, 33) ||
    path.includes("//")
  )
    throw new Error("Provider operation does not match its compiled path");
  try {
    for (const part of path.split("/")) {
      const decoded = decodeURIComponent(part);
      if (
        decoded === "." ||
        decoded === ".." ||
        /[/%\\?#]/.test(decoded) ||
        hasOperationControls(decoded, 33)
      )
        throw new Error("Invalid path segment");
    }
  } catch {
    throw new Error("Provider operation does not match its compiled path");
  }
}
function operationQuery(
  url: URL,
  query: NativeApiOperationDefinition["query"],
  credentials: Record<string, string>,
): void {
  const entries = Object.entries(query ?? {});
  if (entries.length > 16)
    throw new Error("Provider operation query exceeds its bound");
  for (const [name, value] of entries) {
    if (
      (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) && name !== "page[limit]") ||
      ["constructor", "prototype", "__proto__"].includes(name) ||
      (!isString(value) && !isNumber(value) && !isBoolean(value)) ||
      (isNumber(value) && !Number.isFinite(value))
    )
      throw new Error("Provider operation has an invalid query field");
    const text = String(value);
    if (text.length > 1024 || hasOperationControls(text))
      throw new Error("Provider operation query exceeds its bound");
    safeProjection({ [name]: text }, credentials);
    url.searchParams.set(name, text);
  }
  if (url.search.length > 4096)
    throw new Error("Provider operation query exceeds its bound");
}
function operationHeaders(
  record: NativeConnectorRecord,
  target: NativeApiTarget,
  definition: NativeApiOperationDefinition,
): Headers {
  const headers = nativeApiHeaders(target, record.privateState.credentials);
  const exposed = nativeApiExposedCredentials(
    target,
    record.privateState.credentials,
  );
  for (const [name, value] of Object.entries(definition.headers ?? {})) {
    const existing = headers.get(name);
    if (
      [
        "authorization",
        "cookie",
        "host",
        "x-api-key",
        "x-goog-api-key",
      ].includes(name.toLowerCase()) ||
      (existing !== null &&
        Object.values(exposed).some(
          (secret) => secret && existing.includes(secret),
        )) ||
      name.toLowerCase() ===
        (target.profile.auth?.kind === "header"
          ? target.profile.auth.header.toLowerCase()
          : "")
    )
      throw new Error(
        "Provider operation cannot override credential placement",
      );
    safeProjection({ [name]: value }, exposed);
    headers.set(name, value);
  }
  if (definition.method === "POST")
    headers.set("Content-Type", "application/json");
  return headers;
}
function projectedResponse(
  body: BoundaryValue,
  project: (body: BoundaryValue) => BoundaryValue,
): BoundaryValue {
  try {
    return project(body);
  } catch {
    throw new NativeApiError("response");
  }
}
function announcing(
  transport: NativeProviderTransport,
  onDispatch: (() => void) | undefined,
): NativeProviderTransport {
  if (!onDispatch) return transport;
  return {
    ...transport,
    assertCurrent: () => transport.assertCurrent(),
    fetch: (input, init) => {
      onDispatch();
      return transport.fetch(input, init);
    },
  };
}
/** Only trusted drivers may pass definitions/projectors; neither is a UI request input. */
export async function executeNativeApiRequest(
  id: string,
  definition: NativeApiOperationDefinition,
  body: BoundaryValue,
  project: (body: BoundaryValue) => BoundaryValue,
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<BoundaryValue> {
  transport.assertCurrent();
  const record = verifiedOperationRecord(id, definition);
  const target = nativeApiTarget(
    definition.providerId,
    record.configuration.parameters,
  );
  await requireNativeApiBrowserAccess(record, target, transport);
  assertNativeApiAuthority(record);
  if ((await nativeApiFingerprint(target)) !== record.configuration.fingerprint)
    throw new Error(
      "Provider contract changed; configure this connection again",
    );
  const { url, headers } = operationRequest(record, target, definition);
  try {
    const request: NativeApiHttpRequest = {
      url,
      method: definition.method,
      headers,
    };
    const signals = [definition.signal, transport.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    if (signals.length) request.signal = AbortSignal.any(signals);
    if (definition.method === "POST") {
      safeProjection(
        body,
        nativeApiExposedCredentials(target, record.privateState.credentials),
      );
      request.body = JSON.stringify(body);
      if (request.body.length > 262144)
        throw new Error("Provider request is too large");
    }
    await assertNativeConnectorRevision(id, {
      revision: record.revision,
      fingerprint: record.configuration.fingerprint,
    });
    const reply = await nativeApiHttp(
      request,
      announcing(transport, definition.onDispatch),
    );
    const output = projectedResponse(reply, project);
    safeProjection(
      output,
      nativeApiExposedCredentials(target, record.privateState.credentials),
    );
    transport.assertCurrent();
    await assertNativeConnectorRevision(id, {
      revision: record.revision,
      fingerprint: record.configuration.fingerprint,
    });
    transport.assertCurrent();
    return output;
  } catch (error) {
    if (error instanceof NativeApiError && error.code === "authorization")
      await invalidateNativeApiProof(record, target, transport);
    throw error;
  }
}
