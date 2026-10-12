/** Identity comes from provider resource APIs; Microsoft also pins a signed tenant assertion. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  decodeJwtEnvelope,
  verifyBrowserIdTokenClaims,
} from "@opensesame/sdk-browser";
import { z } from "zod";
import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import { safeProviderText } from "./native-api-verify.js";
import { verifyApprovedNativeOAuth } from "./native-approved-oauth-verify.js";
import type { IssuedNativeOAuthToken } from "./native-browser-oauth-token.js";
import type {
  NativeConfiguration,
  NativePending,
  NativeRuntime,
} from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";

const text = z.string().min(1).max(1024);
const guid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
type Identity = NonNullable<NativeRuntime["identity"]>;
export type NativeOAuthVerification = {
  identity: Identity;
  targets: NativeRuntime["targets"];
  scopes: string[] | null;
};
async function readIdentity(
  url: string,
  grant: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
  body?: string,
): Promise<BoundaryValue> {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${grant.accessToken}`,
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  return nativeApiHttp(
    {
      url,
      method: body === undefined ? "GET" : "POST",
      headers,
      body,
    },
    transport,
  );
}
function identity(
  id: string,
  label: string,
  kind = "account",
  assurance: Identity["assurance"] = "account-verified",
): Identity {
  return { id, label, kind, assurance };
}
function projectedIdentity(provider: string, body: BoundaryValue): Identity {
  if (provider === "workos") {
    const value = z
      .object({ sub: text, email: text, name: text.optional() })
      .parse(body);
    return identity(value.sub, value.name ?? value.email);
  }
  if (provider === "resend") {
    z.object({
      data: z.array(z.object({ id: text, name: text })).max(1000),
    }).parse(body);
    return identity(
      "https://api.resend.com",
      "Resend domain access verified",
      "api-resource",
      "credential-valid",
    );
  }
  if (provider === "gitlab") {
    const value = z
      .object({
        id: z.number().int().positive(),
        username: text,
        name: text.optional(),
      })
      .parse(body);
    return identity(String(value.id), value.name ?? value.username);
  }
  if (provider === "dropbox") {
    const value = z
      .object({
        account_id: text,
        email: text,
        name: z.object({ display_name: text }),
      })
      .parse(body);
    return identity(value.account_id, value.name.display_name);
  }
  if (provider === "spotify") {
    const value = z
      .object({ id: text, display_name: text.nullable().optional() })
      .parse(body);
    return identity(value.id, value.display_name ?? value.id);
  }
  const value = z
    .object({ sub: text, email: text.optional(), name: text.optional() })
    .parse(body);
  return identity(value.sub, value.name ?? value.email ?? value.sub);
}
async function microsoftIdentity(
  configuration: NativeConfiguration,
  pending: NativePending,
  grant: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
): Promise<Identity> {
  if (!grant.idToken || !pending.clientId)
    throw new NativeOAuthError("provider");
  const tenant = guid.parse(decodeJwtEnvelope(grant.idToken).claims.tid);
  const expected = configuration.parameters.tenant ?? "common";
  const consumerTenant = "9188040d-6c67-4c5b-b112-36a304b66dad";
  if (
    (expected === "organizations" && tenant.toLowerCase() === consumerTenant) ||
    (expected === "consumers" && tenant.toLowerCase() !== consumerTenant)
  )
    throw new NativeOAuthError("provider");
  if (
    guid.safeParse(expected).success &&
    expected.toLowerCase() !== tenant.toLowerCase()
  )
    throw new NativeOAuthError("provider");
  const jwks = `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`;
  const verified = await verifyBrowserIdTokenClaims({
    token: grant.idToken,
    nonce: pending.state,
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    clientId: pending.clientId,
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
  const account = z
    .object({ id: guid, displayName: text })
    .parse(
      await readIdentity(
        "https://graph.microsoft.com/v1.0/me?$select=id,displayName",
        grant,
        transport,
      ),
    );
  if (verified.tid !== tenant || verified.oid !== account.id)
    throw new NativeOAuthError("provider");
  return identity(
    `${tenant}:${account.id}`,
    account.displayName,
    "tenant-account",
  );
}
async function openrouterIdentity(
  grant: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
): Promise<Identity> {
  const value = z
    .object({ data: z.object({ label: text }) })
    .parse(
      await readIdentity("https://openrouter.ai/api/v1/key", grant, transport),
    );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(grant.accessToken),
  );
  const id = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return identity(id, value.data.label, "authorized-key", "credential-valid");
}
function normalizedScopes(
  provider: string,
  scopes: string[] | null,
): string[] | null {
  if (!scopes || !["microsoft", "microsoft-teams"].includes(provider))
    return scopes;
  return [
    ...new Set(
      scopes.map((scope) =>
        scope.replace(/^https:\/\/graph\.microsoft\.com\//, ""),
      ),
    ),
  ];
}
async function providerIdentity(
  configuration: NativeConfiguration,
  pending: NativePending,
  grant: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
  previousIdentity?: Identity,
): Promise<Identity> {
  const provider = configuration.providerId;
  const endpoints = new Map([
    ["gitlab", "https://gitlab.com/api/v4/user"],
    ["dropbox", "https://api.dropboxapi.com/2/users/get_current_account"],
    ["spotify", "https://api.spotify.com/v1/me"],
    ["google", "https://openidconnect.googleapis.com/v1/userinfo"],
    ["workos", "https://signin.workos.com/oauth2/userinfo"],
    ["resend", "https://api.resend.com/domains"],
  ]);
  let result: Identity;
  try {
    const approved = await verifyApprovedNativeOAuth(
      configuration,
      pending,
      grant,
      transport,
      previousIdentity,
    );
    if (approved) result = approved;
    else if (["microsoft", "microsoft-teams"].includes(provider)) {
      if (previousIdentity) {
        const account = z
          .object({ id: guid, displayName: text })
          .parse(
            await readIdentity(
              "https://graph.microsoft.com/v1.0/me?$select=id,displayName",
              grant,
              transport,
            ),
          );
        if (!previousIdentity.id.endsWith(`:${account.id}`))
          throw new NativeOAuthError("provider");
        result = { ...previousIdentity, label: account.displayName };
      } else
        result = await microsoftIdentity(
          configuration,
          pending,
          grant,
          transport,
        );
    } else if (provider === "openrouter")
      result = await openrouterIdentity(grant, transport);
    else {
      const endpoint = endpoints.get(provider);
      if (!endpoint) throw new NativeOAuthError("provider");
      result = projectedIdentity(
        provider,
        await readIdentity(
          endpoint,
          grant,
          transport,
          provider === "dropbox" ? "null" : undefined,
        ),
      );
    }
  } catch (error) {
    if (error instanceof NativeApiError && error.code === "authorization")
      throw new NativeOAuthError("expired");
    if (error instanceof NativeApiError && error.code === "permission")
      throw new NativeOAuthError("scope");
    if (error instanceof NativeOAuthError) throw error;
    throw new NativeOAuthError("provider");
  }
  return result;
}
export async function verifyNativeBrowserOAuth(
  configuration: NativeConfiguration,
  pending: NativePending,
  grant: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
  previousIdentity?: Identity,
): Promise<NativeOAuthVerification> {
  if (
    !grant.protocolValid ||
    (grant.expiresAt !== null && grant.expiresAt <= Date.now())
  )
    throw new NativeOAuthError("provider");
  const provider = configuration.providerId;
  const result = await providerIdentity(
    configuration,
    pending,
    grant,
    transport,
    previousIdentity,
  );
  const scopes = normalizedScopes(provider, grant.scopes);
  const secrets = {
    access: grant.accessToken,
    refresh: grant.refreshToken ?? "",
    assertion: grant.idToken ?? "",
  };
  safeProviderText(result.id, secrets);
  safeProviderText(result.label, secrets);
  for (const scope of scopes ?? []) safeProviderText(scope, secrets);
  if (
    !["openrouter", "codeberg", "crowdin"].includes(provider) &&
    (!scopes || pending.scopes.some((scope) => !scopes.includes(scope)))
  )
    throw new NativeOAuthError("scope");
  if (
    Object.values(configuration.targetIds).some(
      (target) => target !== result.id,
    )
  )
    throw new NativeOAuthError("provider");
  return {
    identity: result,
    targets: [{ id: result.id, label: result.label, kind: result.kind }],
    scopes,
  };
}
