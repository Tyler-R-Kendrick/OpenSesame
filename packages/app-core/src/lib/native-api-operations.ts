/** Provider-owned request definitions consume one verified saved credential. */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { connectPlan } from "./connect-plan.js";
import {
  nativeApiExposedCredentials,
  nativeApiHeaders,
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
  path: string;
  origin?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
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
  const origins =
    allowed?.kind === "api-key"
      ? (allowed.preset?.serviceUrls ?? []).map(
          (url) => providerUrl(url, target, {}).origin,
        )
      : [];
  const origin = definition.origin ?? verifiedOrigin;
  if (
    (origin !== verifiedOrigin && !origins.includes(origin)) ||
    new URL(origin).origin !== origin ||
    !definition.path.startsWith("/") ||
    definition.path.startsWith("//") ||
    /[?#\\\r\n]/.test(definition.path)
  )
    throw new Error("Provider operation does not match its compiled target");
  const url = new URL(definition.path, origin);
  if (url.origin !== origin)
    throw new Error("Provider operation changed its target");
  const headers = operationHeaders(record, target, definition);
  return { url, headers };
}
function operationHeaders(
  record: NativeConnectorRecord,
  target: NativeApiTarget,
  definition: NativeApiOperationDefinition,
): Headers {
  const headers = nativeApiHeaders(target, record.privateState.credentials);
  for (const [name, value] of Object.entries(definition.headers ?? {})) {
    if (
      [
        "authorization",
        "cookie",
        "host",
        "x-api-key",
        "x-goog-api-key",
      ].includes(name.toLowerCase()) ||
      name.toLowerCase() ===
        (target.profile.auth?.kind === "header"
          ? target.profile.auth.header.toLowerCase()
          : "")
    )
      throw new Error(
        "Provider operation cannot override credential placement",
      );
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
    if (definition.signal) request.signal = definition.signal;
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
    const reply = await nativeApiHttp(request, transport);
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
    return output;
  } catch (error) {
    if (error instanceof NativeApiError && error.code === "authorization")
      await invalidateNativeApiProof(record, target, transport);
    throw error;
  }
}
