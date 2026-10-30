import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { Redacted } from "effect";
import { EgressDenied } from "./capabilities/egress.js";
import { NativeApiError } from "./native-api-http.js";
import {
  NATIVE_AWS_SERVICES,
  type NativeAwsTarget,
  nativeAwsEndpoint,
} from "./native-aws-input.js";
import { readBoundedText } from "./native-bounded-body.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { signAws } from "./secret-fs/s3-sigv4.js";

/** A response error type is a refusal of the key, of its permissions, or of the rate. */
const REFUSED_KEY = new Set([
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "InvalidClientTokenId",
  "SignatureDoesNotMatch",
  "ExpiredTokenException",
  "ExpiredToken",
  "IncompleteSignature",
  "MissingAuthenticationToken",
  "MissingAuthenticationTokenException",
]);
const REFUSED_PERMISSION = new Set([
  "AccessDeniedException",
  "AccessDenied",
  "UnauthorizedOperation",
]);
const RATE_LIMITED = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "RequestLimitExceeded",
]);

/** `com.amazon.coral.service#AccessDeniedException` and `AccessDeniedException` are one type. */
function errorType(body: string): string {
  try {
    const parsed: BoundaryValue = JSON.parse(body);
    const type = isJsonObject(parsed) ? parsed.__type : undefined;
    return isString(type) ? (type.split("#").pop() ?? "") : "";
  } catch {
    return "";
  }
}

function refusal(status: number, body: string): NativeApiError {
  return awsRefusal(status, errorType(body));
}

/** The error AWS's own error type and status stand for, whatever the protocol that carried them. */
export function awsRefusal(status: number, type: string): NativeApiError {
  if (status === 429 || RATE_LIMITED.has(type))
    return new NativeApiError("rate-limit", status);
  if (REFUSED_KEY.has(type) || status === 401)
    return new NativeApiError("authorization", status);
  if (REFUSED_PERMISSION.has(type) || status === 403)
    return new NativeApiError("permission", status);
  return new NativeApiError("response", status);
}

export function awsSigningMaterial(
  target: Pick<NativeAwsTarget, "parameters" | "credentials">,
) {
  return {
    accessKeyId: target.parameters.access_key_id ?? "",
    secretAccessKey: Redacted.make(target.credentials.secret_access_key ?? ""),
    sessionToken: target.credentials.session_token
      ? Redacted.make(target.credentials.session_token)
      : undefined,
  };
}

/**
 * One signed AWS JSON 1.1 call. The upstream message is never returned or
 * thrown: AWS echoes request detail in it, and the page shows only the
 * NativeApiError's own text.
 */
export async function nativeAwsCall(
  target: NativeAwsTarget,
  transport: NativeProviderTransport,
  action: string,
  payload: Record<string, string | number | boolean>,
): Promise<BoundaryValue> {
  transport.assertCurrent();
  const service = NATIVE_AWS_SERVICES[target.service];
  const body = JSON.stringify(payload);
  const signed = signAws({
    method: "POST",
    url: nativeAwsEndpoint(target.service, target.parameters.region ?? ""),
    headers: new Headers({
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `${service.targetPrefix}.${action}`,
    }),
    payloadHash: bytesToHex(sha256(new TextEncoder().encode(body))),
    region: target.parameters.region ?? "",
    credentials: awsSigningMaterial(target),
    service: service.service,
    payloadHashHeader: false,
    pathEncoding: "twice",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await transport.fetch(signed.url, {
      method: "POST",
      headers: signed.headers,
      body,
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
    if (!response.ok) throw refusal(response.status, text);
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
