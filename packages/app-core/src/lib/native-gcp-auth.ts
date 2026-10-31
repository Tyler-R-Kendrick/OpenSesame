/**
 * Google Cloud sign-in from a browser without a consent screen (ADR 0198): the
 * person's own service-account key signs a short-lived JWT in this page, and
 * Google's token endpoint answers it with an access token that lives for one
 * call and is never stored. The key is parsed here, sealed with the
 * connection, and never shown again; nothing in an error repeats it.
 */
import { isJsonObject, isString } from "@opensesame/os-domain";
import type { BoundaryValue } from "@opensesame/os-domain";
import { EgressDenied } from "./capabilities/egress.js";
import { NativeApiError } from "./native-api-http.js";
import {
  base64ToBytes,
  bytesToBase64Url,
  textToBase64Url,
} from "./native-base64.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { finishNativeResponseBody } from "./native-response-lifetime.js";
import { readNativeResponseText } from "./native-response-text.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const EMAIL =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[a-z][a-z0-9-]{3,61}\.(?:iam\.)?gserviceaccount\.com$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const PEM =
  /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]{200,8192})-----END PRIVATE KEY-----\s*$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{20,4096}$/;

export type GcpServiceAccount = {
  clientEmail: string;
  projectId: string | null;
  privateKey: string;
};

export function isGcpProjectId(value: string): boolean {
  return PROJECT.test(value);
}

export function isGcpServiceAccountEmail(value: string): boolean {
  return EMAIL.test(value);
}

/** The few fields of a service-account key file this needs, validated; throws text safe to show. */
export function parseGcpServiceAccount(text: string): GcpServiceAccount {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Paste the service account key file, a JSON document");
  }
  const fields = isJsonObject(parsed) ? parsed : null;
  const email = fields?.client_email;
  const key = fields?.private_key;
  const project = fields?.project_id;
  if (
    !fields ||
    fields.type !== "service_account" ||
    !isString(email) ||
    !EMAIL.test(email) ||
    !isString(key) ||
    !PEM.test(key)
  )
    throw new Error("That is not a service account key file");
  return {
    clientEmail: email,
    projectId: isString(project) && PROJECT.test(project) ? project : null,
    privateKey: key,
  };
}

async function importKey(pem: string): Promise<CryptoKey> {
  const body = PEM.exec(pem)?.[1]?.replace(/\s+/g, "") ?? "";
  return crypto.subtle.importKey(
    "pkcs8",
    base64ToBytes(body),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** The signed assertion Google's JWT-bearer grant asks for: RS256, valid for an hour at most. */
export async function signGcpAssertion(
  account: GcpServiceAccount,
  nowSeconds: number,
): Promise<string> {
  const header = textToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = textToBase64Url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importKey(account.privateKey),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function retireTokenResponse(
  response: Response | undefined,
): Promise<void> {
  if (!response) return;
  try {
    if (!response.bodyUsed)
      await response.body?.cancel().catch(() => undefined);
  } finally {
    finishNativeResponseBody(response);
  }
}

/** An access token for this key, for one call. A refused key is an authorization error, never Google's words. */
export async function gcpAccessToken(
  account: GcpServiceAccount,
  transport: NativeProviderTransport,
): Promise<string> {
  transport.assertCurrent();
  let assertion: string;
  try {
    assertion = await signGcpAssertion(account, Math.floor(Date.now() / 1000));
  } catch {
    throw new NativeApiError("authorization");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response | undefined;
  try {
    response = await transport.fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      signal: controller.signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    transport.assertCurrent();
    if (response.redirected) throw new NativeApiError("response");
    const text = await readNativeResponseText(response, {
      maxBytes: 16 * 1024,
      signal: controller.signal,
      assertCurrent: () => transport.assertCurrent(),
      invalid: () => new NativeApiError("response"),
    });
    if ([400, 401].includes(response.status))
      throw new NativeApiError("authorization", response.status);
    if (response.status === 403) throw new NativeApiError("permission", 403);
    if (response.status === 429) throw new NativeApiError("rate-limit", 429);
    if (!response.ok) throw new NativeApiError("response", response.status);
    const parsed: BoundaryValue = JSON.parse(text);
    const token = isJsonObject(parsed) ? parsed.access_token : undefined;
    if (!isString(token) || !TOKEN.test(token))
      throw new NativeApiError("response");
    transport.assertCurrent();
    return token;
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    if (error instanceof EgressDenied) throw new NativeApiError("deployment");
    if (error instanceof SyntaxError) throw new NativeApiError("response");
    throw new NativeApiError("network");
  } finally {
    try {
      await retireTokenResponse(response);
    } finally {
      clearTimeout(timeout);
    }
  }
}
