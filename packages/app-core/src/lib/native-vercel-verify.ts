/** Pin Vercel's signed account assertion to the consent transaction and userinfo. */
import {
  decodeJwtEnvelope,
  verifyBrowserIdTokenClaims,
} from "@opensesame/sdk-browser";
import { z } from "zod";
import { nativeApiHttp } from "./native-api-http.js";
import { safeProviderText } from "./native-api-verify.js";
import type { IssuedNativeOAuthToken } from "./native-browser-oauth-token.js";
import type {
  NativeConfiguration,
  NativePending,
  NativeRuntime,
} from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  NATIVE_VERCEL_ISSUER,
  NATIVE_VERCEL_USERINFO,
} from "./native-vercel-auth.js";

const userinfo = z.object({
  sub: z.string().min(1).max(256),
  preferred_username: z.string().min(1).max(1024).optional(),
  email: z.string().min(1).max(1024).optional(),
  name: z.string().min(1).max(1024).optional(),
});
type Identity = NonNullable<NativeRuntime["identity"]>;
function assertVercelBinding(
  configuration: NativeConfiguration,
  pending: NativePending,
): void {
  if (
    configuration.providerId !== "vercel" ||
    pending.providerId !== "vercel" ||
    pending.issuer !== NATIVE_VERCEL_ISSUER ||
    !pending.clientId ||
    configuration.clientId !== pending.clientId
  )
    throw new NativeOAuthError("provider");
}
async function vercelSubject(
  pending: NativePending,
  token: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
): Promise<string> {
  if (!token.idToken || decodeJwtEnvelope(token.idToken).header.alg !== "RS256")
    throw new NativeOAuthError("provider");
  const jwks = "https://vercel.com/.well-known/jwks";
  const claims = await verifyBrowserIdTokenClaims({
    token: token.idToken,
    nonce: pending.state,
    issuer: NATIVE_VERCEL_ISSUER,
    clientId: pending.clientId ?? "",
    jwksUri: jwks,
    fetchImpl: (url, init) => {
      if (String(url) !== jwks) throw new NativeOAuthError("provider");
      return transport.fetch(url, {
        ...init,
        credentials: "omit",
        redirect: "error",
        mode: "cors",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    },
  });
  return claims.sub;
}
export async function verifyNativeVercelIdentity(
  configuration: NativeConfiguration,
  pending: NativePending,
  token: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
  previousIdentity?: Identity,
): Promise<Identity> {
  assertVercelBinding(configuration, pending);
  const expectedSubject =
    previousIdentity?.id ?? (await vercelSubject(pending, token, transport));
  const account = userinfo.parse(
    await nativeApiHttp(
      {
        url: NATIVE_VERCEL_USERINFO,
        method: "GET",
        headers: new Headers({
          accept: "application/json",
          authorization: `Bearer ${token.accessToken}`,
        }),
      },
      transport,
    ),
  );
  if (account.sub !== expectedSubject) throw new NativeOAuthError("provider");
  const label =
    account.name ?? account.preferred_username ?? account.email ?? account.sub;
  const credentials = {
    access: token.accessToken,
    refresh: token.refreshToken ?? "",
    assertion: token.idToken ?? "",
  };
  safeProviderText(account.sub, credentials);
  safeProviderText(label, credentials);
  return {
    id: account.sub,
    label,
    kind: "identity-account",
    assurance: "account-verified",
  };
}
