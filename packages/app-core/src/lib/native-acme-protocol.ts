/**
 * ACME (RFC 8555) from a browser, the part that talks to the certificate
 * authority (ADR 0198): the account key, signed requests (ES256 JWS), the
 * replay nonce, and the bounded reading of what comes back. Every address is
 * the CA's own, pinned to its directory's host. What the CA says in a problem
 * document is reduced to a class; its words are never shown.
 */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { EgressDenied } from "./capabilities/egress.js";
import { NativeApiError } from "./native-api-http.js";
import { bytesToBase64Url, textToBase64Url } from "./native-base64.js";
import { readBoundedText } from "./native-bounded-body.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

export type AcmeEnvironment = "production" | "staging";

export const ACME_DIRECTORIES = {
  production: "https://acme-v02.api.letsencrypt.org/directory",
  staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
} satisfies Record<AcmeEnvironment, string>;

const NONCE = /^[A-Za-z0-9_-]{8,128}$/;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

export type AcmeAccountKey = {
  privateKey: CryptoKey;
  /** The public half, in the member order RFC 7638 hashes. */
  jwk: { crv: "P-256"; kty: "EC"; x: string; y: string };
  thumbprint: string;
};

export type AcmeReply = {
  status: number;
  text: string;
  location: string | null;
  retryAfterMs: number | null;
};

export type AcmeSigner = { kind: "jwk" } | { kind: "kid"; url: string };

export type AcmeClient = {
  environment: AcmeEnvironment;
  directory: { newNonce: string; newAccount: string; newOrder: string };
  /** A signed POST; a null payload is POST-as-GET. Retries once on a stale nonce. */
  post: (
    url: string,
    payload: BoundaryValue | null,
    who: AcmeSigner,
    accept?: string,
  ) => Promise<AcmeReply>;
  /** Whether a CA-supplied address is the CA's own. */
  own: (url: BoundaryValue | undefined) => url is string;
};

/** A fresh P-256 account key, as the JWK text that is sealed with the connection. */
export async function generateAcmeAccountJwk(): Promise<string> {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

/** The saved key, imported to sign with; a malformed one is refused before any request. */
export async function acmeAccountKey(text: string): Promise<AcmeAccountKey> {
  try {
    const parsed: BoundaryValue = JSON.parse(text);
    const jwk = isJsonObject(parsed) ? parsed : null;
    if (
      !jwk ||
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      !isString(jwk.x) ||
      !isString(jwk.y) ||
      !isString(jwk.d)
    )
      throw new Error("not an account key");
    const privateKey = await crypto.subtle.importKey("jwk", jwk, ECDSA, false, [
      "sign",
    ]);
    const publicJwk = { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y } as const;
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(publicJwk)),
      ),
    );
    return { privateKey, jwk: publicJwk, thumbprint: bytesToBase64Url(digest) };
  } catch {
    throw new Error("The saved account key is not usable; connect again");
  }
}

/** The DNS-01 TXT value for a challenge token (RFC 8555 §8.4). */
export async function acmeDnsTxtValue(
  token: string,
  key: AcmeAccountKey,
): Promise<string> {
  const keyAuthorization = new TextEncoder().encode(
    `${token}.${key.thumbprint}`,
  );
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", keyAuthorization)),
  );
}

type Problem =
  | "badNonce"
  | "authorization"
  | "permission"
  | "rate-limit"
  | "other";

function classify(status: number, text: string): Problem {
  let type = "";
  try {
    const parsed: BoundaryValue = JSON.parse(text);
    const found = isJsonObject(parsed) ? parsed.type : undefined;
    if (isString(found))
      type = found.replace("urn:ietf:params:acme:error:", "");
  } catch {
    // No problem document: the status alone decides.
  }
  if (type === "badNonce") return "badNonce";
  if (type === "rateLimited" || status === 429) return "rate-limit";
  if (
    ["unauthorized", "accountDoesNotExist", "badSignatureAlgorithm"].includes(
      type,
    ) ||
    status === 401
  )
    return "authorization";
  if (
    [
      "userActionRequired",
      "caa",
      "rejectedIdentifier",
      "externalAccountRequired",
    ].includes(type) ||
    status === 403
  )
    return "permission";
  return "other";
}

const FAILURE = {
  badNonce: "response",
  authorization: "authorization",
  permission: "permission",
  "rate-limit": "rate-limit",
  other: "response",
} as const satisfies Record<Problem, NativeApiError["code"]>;

function retryAfter(headers: Headers): number | null {
  const seconds = Number(headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds, 10) * 1000
    : null;
}

async function exchange(
  transport: NativeProviderTransport,
  url: string,
  init: RequestInit,
  limit: number,
) {
  transport.assertCurrent();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await transport.fetch(url, {
      ...init,
      signal: controller.signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    transport.assertCurrent();
    if (response.redirected) throw new NativeApiError("response");
    const text =
      init.method === "HEAD" ? "" : await readBoundedText(response, limit);
    if (controller.signal.aborted) throw new NativeApiError("network");
    return { response, text };
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    if (error instanceof EgressDenied) throw new NativeApiError("deployment");
    throw new NativeApiError("network");
  } finally {
    clearTimeout(timeout);
  }
}

/** Whether an address is the CA's own: its host, HTTPS, under /acme/, nothing smuggled in. */
export function acmeOwn(
  environment: AcmeEnvironment,
): (value: BoundaryValue | undefined) => value is string {
  const host = new URL(ACME_DIRECTORIES[environment]).host;
  return (value: BoundaryValue | undefined): value is string => {
    if (!isString(value) || value.length > 512) return false;
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.host === host &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.startsWith("/acme/")
      );
    } catch {
      return false;
    }
  };
}

type Directory = { newNonce: string; newAccount: string; newOrder: string };

/** The CA's directory, with every address it names held to the CA's own host. */
async function readDirectory(
  environment: AcmeEnvironment,
  transport: NativeProviderTransport,
): Promise<Directory> {
  const own = acmeOwn(environment);
  const { response, text } = await exchange(
    transport,
    ACME_DIRECTORIES[environment],
    { method: "GET", headers: { Accept: "application/json" } },
    64 * 1024,
  );
  if (!response.ok) throw new NativeApiError("response", response.status);
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NativeApiError("response");
  }
  const found = isJsonObject(parsed) ? parsed : null;
  const newNonce = found?.newNonce;
  const newAccount = found?.newAccount;
  const newOrder = found?.newOrder;
  if (!own(newNonce) || !own(newAccount) || !own(newOrder))
    throw new NativeApiError("response");
  return { newNonce, newAccount, newOrder };
}

/** Each reply carries the next nonce; one is fetched only when none is held. */
function nonceSource(transport: NativeProviderTransport, newNonce: string) {
  let held: string | null = null;
  return {
    remember(headers: Headers) {
      const next = headers.get("replay-nonce");
      held = next && NONCE.test(next) ? next : null;
    },
    async next(): Promise<string> {
      if (held) {
        const nonce = held;
        held = null;
        return nonce;
      }
      const probe = await exchange(
        transport,
        newNonce,
        { method: "HEAD" },
        1024,
      );
      const nonce = probe.response.headers.get("replay-nonce");
      if (!nonce || !NONCE.test(nonce)) throw new NativeApiError("response");
      return nonce;
    },
  };
}

/** A flattened-JSON JWS (RFC 7515) with ES256, naming the key by its JWK or by the account URL. */
async function signRequest(
  key: AcmeAccountKey,
  nonce: string,
  url: string,
  payload: BoundaryValue | null,
  who: AcmeSigner,
): Promise<string> {
  const header = textToBase64Url(
    JSON.stringify({
      alg: "ES256",
      nonce,
      url,
      ...(who.kind === "kid" ? { kid: who.url } : { jwk: key.jwk }),
    }),
  );
  const body = payload === null ? "" : textToBase64Url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return JSON.stringify({
    protected: header,
    payload: body,
    signature: bytesToBase64Url(new Uint8Array(signature)),
  });
}

export async function openAcme(
  environment: AcmeEnvironment,
  key: AcmeAccountKey,
  transport: NativeProviderTransport,
): Promise<AcmeClient> {
  const own = acmeOwn(environment);
  const directory = await readDirectory(environment, transport);
  const nonces = nonceSource(transport, directory.newNonce);

  async function post(
    url: string,
    payload: BoundaryValue | null,
    who: AcmeSigner,
    accept = "application/json",
  ): Promise<AcmeReply> {
    if (!own(url) || (who.kind === "kid" && !own(who.url)))
      throw new NativeApiError("response");
    for (let attempt = 0; ; attempt += 1) {
      const { response, text } = await exchange(
        transport,
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/jose+json", Accept: accept },
          body: await signRequest(key, await nonces.next(), url, payload, who),
        },
        128 * 1024,
      );
      nonces.remember(response.headers);
      if (response.ok)
        return {
          status: response.status,
          text,
          location: response.headers.get("location"),
          retryAfterMs: retryAfter(response.headers),
        };
      const problem = classify(response.status, text);
      // A nonce the CA had already forgotten is the CA's to correct, once.
      if (problem === "badNonce" && attempt === 0) continue;
      throw new NativeApiError(FAILURE[problem], response.status);
    }
  }

  return { environment, directory, post, own };
}

/** A reply that must be a JSON object. */
export function acmeObject(reply: AcmeReply): Record<string, BoundaryValue> {
  try {
    const parsed: BoundaryValue = JSON.parse(reply.text);
    if (isJsonObject(parsed)) return parsed;
  } catch {
    // Falls through to the refusal below.
  }
  throw new NativeApiError("response");
}
