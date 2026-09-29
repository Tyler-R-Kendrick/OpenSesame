/**
 * Google service-account access token, minted in the browser (RFC 7523 JWT
 * bearer grant). The token is memory-only and short-lived: it is handed to the
 * Cloud KMS transport for one enrollment or proof and then dropped.
 *
 * The token endpoint is a constant. The service-account JSON carries its own
 * `token_uri`, and honouring it would send a signed assertion to whatever host
 * the pasted file names — so it is read and ignored.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { ProtectionError } from "../errors.js";
import { b64ToBytes, bytesToB64 } from "./cloud-wrapping-secret.js";

export const GCP_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GCP_KMS_SCOPE = "https://www.googleapis.com/auth/cloudkms";
const ASSERTION_LIFETIME_SECONDS = 3600;

function base64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function textBase64Url(text: string): string {
  return base64Url(new TextEncoder().encode(text));
}

function pkcs8FromPem(pem: string): Uint8Array {
  // One pattern for both armor lines, so no literal armored block is spelled.
  const body = pem
    .replace(/-----(?:BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (body.length === 0) {
    throw new ProtectionError(
      "malformed_encoding",
      "Service-account private key must be a PKCS#8 PEM.",
    );
  }
  return b64ToBytes(body);
}

type ServiceAccount = {
  clientEmail: string;
  privateKey: string;
  keyId?: string;
};

function parseServiceAccount(json: string): ServiceAccount {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ProtectionError(
      "malformed_encoding",
      "Service-account JSON is not valid JSON.",
    );
  }
  if (
    !isJsonObject(parsed) ||
    !isString(parsed.client_email) ||
    !isString(parsed.private_key)
  ) {
    throw new ProtectionError(
      "malformed_encoding",
      "Service-account JSON needs client_email and private_key.",
    );
  }
  const account: ServiceAccount = {
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
  };
  if (isString(parsed.private_key_id)) account.keyId = parsed.private_key_id;
  return account;
}

async function signAssertion(
  account: ServiceAccount,
  nowSeconds: number,
): Promise<string> {
  const base = { alg: "RS256", typ: "JWT" };
  const header = account.keyId ? { ...base, kid: account.keyId } : base;
  const claims = {
    iss: account.clientEmail,
    scope: GCP_KMS_SCOPE,
    aud: GCP_TOKEN_ENDPOINT,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_LIFETIME_SECONDS,
  };
  const signingInput = `${textBase64Url(JSON.stringify(header))}.${textBase64Url(JSON.stringify(claims))}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8FromPem(account.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (caught) {
    if (caught instanceof ProtectionError) throw caught;
    throw new ProtectionError(
      "malformed_encoding",
      "Service-account private key could not be imported.",
    );
  }
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${base64Url(signature)}`;
}

export type GcpAccessTokenOptions = {
  serviceAccountJson: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/** Exchange a signed assertion for a Cloud KMS access token. */
export async function mintGcpAccessToken(
  options: GcpAccessTokenOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
  const assertion = await signAssertion(
    parseServiceAccount(options.serviceAccountJson),
    nowSeconds,
  );
  let response: Response;
  try {
    response = await fetchImpl(GCP_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
  } catch {
    throw new ProtectionError(
      "unavailable",
      "Google token request failed (network or CORS).",
    );
  }
  if (!response.ok) {
    throw new ProtectionError(
      "provider_denied",
      `Google refused the service-account credential (${response.status}).`,
    );
  }
  const json: BoundaryValue = await response.json();
  if (!isJsonObject(json) || !isString(json.access_token)) {
    throw new ProtectionError(
      "provider_denied",
      "Google token response carried no access token.",
    );
  }
  return json.access_token;
}
