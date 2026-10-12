/** Vault owns the confidential IdP exchange; this browser receives only its Vault token. */
import { z } from "zod";
import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { nativeLocalInstanceOrigin } from "./native-local-instance-http.js";

export interface NativeVaultOidcInput {
  providerId: "vault" | "openbao";
  endpoint: string;
  namespace: string;
  authMount: string;
  role: string;
  connectionId?: string;
  revision?: number;
}
export function vaultOidcInput(input: NativeVaultOidcInput) {
  if (!["vault", "openbao"].includes(input.providerId))
    throw new Error("Select a Vault or OpenBao instance");
  const endpoint = nativeLocalInstanceOrigin(input.endpoint);
  const authMount = input.authMount || "oidc";
  if (
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(authMount) ||
    authMount.length > 256
  )
    throw new Error("Enter the instance's OIDC auth mount");
  if (!/^[A-Za-z0-9_/-]{0,256}$/.test(input.namespace))
    throw new Error("Enter a valid provider namespace");
  if (!/^[A-Za-z0-9_.-]{0,256}$/.test(input.role))
    throw new Error("Enter a valid provider OIDC role");
  return { ...input, endpoint, authMount };
}
export function vaultHeaders(namespace: string): Headers {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  if (namespace) headers.set("X-Vault-Namespace", namespace);
  return headers;
}
export function vaultOidcRandom(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function vaultAuthorizationUrl(
  input: NativeVaultOidcInput,
  redirectUri: string,
  clientNonce: string,
  transport: NativeProviderTransport,
) {
  const request = vaultOidcInput(input);
  requireVaultRedirectUri(redirectUri);
  const reply = await nativeApiHttp(
    {
      url: `${request.endpoint}/v1/auth/${request.authMount}/oidc/auth_url`,
      method: "POST",
      headers: vaultHeaders(request.namespace),
      body: JSON.stringify({
        role: request.role,
        redirect_uri: redirectUri,
        client_nonce: clientNonce,
      }),
    },
    transport,
  );
  const parsed = z
    .object({ data: z.object({ auth_url: z.string().min(1).max(16384) }) })
    .safeParse(reply);
  if (!parsed.success) throw new NativeApiError("response");
  const url = providerOidcUrl(parsed.data.data.auth_url);
  const query = url.searchParams;
  const state = query.get("state");
  const nonce = query.get("nonce");
  if (
    !state ||
    !/^[!-~]{16,512}$/.test(state) ||
    !nonce ||
    !/^[!-~]{1,512}$/.test(nonce) ||
    query.get("redirect_uri") !== redirectUri ||
    query.get("response_type") !== "code" ||
    (query.get("response_mode") ?? "query") !== "query" ||
    ["state", "nonce", "redirect_uri", "response_type", "response_mode"].some(
      (name) => query.getAll(name).length > 1,
    )
  )
    throw new Error(
      "The instance did not return a browser OIDC authorization URL",
    );
  return { authorizationUrl: url.href, state, nonce };
}
const Issued = z.object({
  auth: z.object({
    client_token: z
      .string()
      .min(1)
      .max(32768)
      .regex(/^[!-~]+$/),
    lease_duration: z.number().finite().nonnegative().max(315360000),
  }),
});
/** Settle the mint reply even after disposal so the issued grant can be sealed for revocation. */
export async function vaultExchangeOidc(
  input: NativeVaultOidcInput,
  callback: { state: string; code: string; nonce: string; clientNonce: string },
  transport: NativeProviderTransport,
) {
  const request = vaultOidcInput(input);
  const url = new URL(
    `${request.endpoint}/v1/auth/${request.authMount}/oidc/callback`,
  );
  url.search = new URLSearchParams({
    state: callback.state,
    code: callback.code,
    nonce: callback.nonce,
    client_nonce: callback.clientNonce,
  }).toString();
  transport.assertCurrent();
  const deadline = AbortSignal.timeout(15_000);
  try {
    const response = await (
      transport.settleCredentialMutation ?? transport.fetch
    )(url, {
      method: "GET",
      headers: vaultHeaders(request.namespace),
      signal: deadline,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      mode: "cors",
    });
    if (!response.ok || response.redirected)
      throw new NativeApiError("authorization", response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new NativeApiError("response");
    const cancel = () => {
      void reader.cancel();
    };
    deadline.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        deadline.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 256 * 1024) throw new NativeApiError("response");
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const parsed = Issued.safeParse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (!parsed.success) throw new NativeApiError("response");
      return {
        accessToken: parsed.data.auth.client_token,
        expiresAt:
          parsed.data.auth.lease_duration === 0
            ? null
            : Date.now() + parsed.data.auth.lease_duration * 1000,
      };
    } finally {
      deadline.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    throw new NativeApiError("network");
  }
}

function requireVaultRedirectUri(redirectUri: string) {
  const redirect = new URL(redirectUri);
  if (
    (redirect.protocol !== "https:" &&
      !(
        redirect.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)
      )) ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  )
    throw new Error("Register a secure browser callback URL");
}

function providerOidcUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new NativeApiError("response");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error(
      "The instance did not return a browser OIDC authorization URL",
    );
  return url;
}
