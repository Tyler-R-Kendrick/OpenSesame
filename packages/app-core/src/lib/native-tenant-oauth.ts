import type { BoundaryValue } from "@opensesame/os-domain";
/** Approved public-SPA authorization routes bind every endpoint to one tenant. */
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

type Provider = "auth0" | "okta";
type Identity = NonNullable<NativeRuntime["identity"]>;
export function nativeTenantOAuthEndpoints(provider: Provider, domain: string) {
  if (
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) ||
    domain.includes("..")
  )
    throw new NativeOAuthError("provider");
  const suffixes =
    provider === "auth0"
      ? [".auth0.com"]
      : [".okta.com", ".okta-emea.com", ".oktapreview.com"];
  if (
    !suffixes.some(
      (suffix) => domain.endsWith(suffix) && domain.length > suffix.length,
    )
  )
    throw new NativeOAuthError("provider");
  const origin = `https://${domain}`;
  return provider === "auth0"
    ? {
        issuer: `${origin}/`,
        authorization: `${origin}/authorize`,
        token: `${origin}/oauth/token`,
        jwks: `${origin}/.well-known/jwks.json`,
        userinfo: `${origin}/userinfo`,
        revocation: `${origin}/oauth/revoke`,
      }
    : {
        issuer: origin,
        authorization: `${origin}/oauth2/v1/authorize`,
        token: `${origin}/oauth2/v1/token`,
        jwks: `${origin}/oauth2/v1/keys`,
        userinfo: `${origin}/api/v1/users/me`,
        revocation: `${origin}/oauth2/v1/revoke`,
      };
}
const subject = z.string().min(1).max(256);
const text = z.string().min(1).max(1024);
function project(provider: Provider, body: BoundaryValue): Identity {
  if (provider === "okta") {
    const value = z
      .object({
        id: subject,
        profile: z.object({
          login: text,
          displayName: text.optional(),
          firstName: text.optional(),
          lastName: text.optional(),
        }),
      })
      .parse(body);
    return {
      id: value.id,
      label: value.profile.displayName ?? value.profile.login,
      kind: "tenant-account",
      assurance: "account-verified",
    };
  }
  const value = z
    .object({
      sub: subject,
      email: text.optional(),
      name: text.optional(),
      nickname: text.optional(),
    })
    .parse(body);
  return {
    id: value.sub,
    label: value.name ?? value.nickname ?? value.email ?? value.sub,
    kind: "identity-account",
    assurance: "account-verified",
  };
}
type TenantBinding = {
  provider: Provider;
  endpoints: ReturnType<typeof nativeTenantOAuthEndpoints>;
};
function tenantBinding(
  configuration: NativeConfiguration,
  pending: NativePending,
): TenantBinding {
  const provider = configuration.providerId;
  if (provider !== "auth0" && provider !== "okta")
    throw new NativeOAuthError("provider");
  const endpoints = nativeTenantOAuthEndpoints(
    provider,
    configuration.parameters.domain ?? "",
  );
  if (
    pending.providerId !== provider ||
    pending.issuer !== endpoints.issuer ||
    pending.endpoint !== endpoints.token ||
    !pending.clientId ||
    pending.clientId !== configuration.clientId
  )
    throw new NativeOAuthError("provider");
  return { provider, endpoints };
}
async function tenantSubject(
  pending: NativePending,
  token: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
  endpoints: ReturnType<typeof nativeTenantOAuthEndpoints>,
): Promise<string> {
  if (!token.idToken || decodeJwtEnvelope(token.idToken).header.alg !== "RS256")
    throw new NativeOAuthError("provider");
  const claims = await verifyBrowserIdTokenClaims({
    token: token.idToken,
    nonce: pending.state,
    issuer: endpoints.issuer,
    clientId: pending.clientId ?? "",
    jwksUri: endpoints.jwks,
    fetchImpl: (url, init) => {
      if (String(url) !== endpoints.jwks)
        throw new NativeOAuthError("provider");
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
export async function verifyNativeTenantOAuthIdentity(
  configuration: NativeConfiguration,
  pending: NativePending,
  token: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
  previousIdentity?: Identity,
): Promise<Identity> {
  const { provider, endpoints } = tenantBinding(configuration, pending);
  const expectedSubject =
    previousIdentity?.id ??
    (await tenantSubject(pending, token, transport, endpoints));
  const identity = project(
    provider,
    await nativeApiHttp(
      {
        url: endpoints.userinfo,
        method: "GET",
        headers: new Headers({
          accept: "application/json",
          authorization: `Bearer ${token.accessToken}`,
        }),
      },
      transport,
    ),
  );
  if (identity.id !== expectedSubject) throw new NativeOAuthError("provider");
  const secrets = {
    access: token.accessToken,
    refresh: token.refreshToken ?? "",
    assertion: token.idToken ?? "",
  };
  safeProviderText(identity.id, secrets);
  safeProviderText(identity.label, secrets);
  return identity;
}
