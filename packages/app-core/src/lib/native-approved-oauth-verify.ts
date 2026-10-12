/** Verification dispatch for newly admitted, provider-approved public-client routes. */
import { z } from "zod";
import { nativeApiHttp } from "./native-api-http.js";
import type { IssuedNativeOAuthToken } from "./native-browser-oauth-token.js";
import { verifyNativeCodebergIdentity } from "./native-codeberg-provider.js";
import type {
  NativeConfiguration,
  NativePending,
  NativeRuntime,
} from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { verifyNativeDatabricksIdentity } from "./native-databricks-provider.js";
import { verifyNativeDiscordIdentity } from "./native-discord-verify.js";
import { verifyNativeTenantOAuthIdentity } from "./native-tenant-oauth.js";
import { verifyNativeTwitchIdentity } from "./native-twitch-device-verify.js";
import { verifyNativeVercelIdentity } from "./native-vercel-verify.js";
type Identity = NonNullable<NativeRuntime["identity"]>;
export async function verifyApprovedNativeOAuth(
  configuration: NativeConfiguration,
  pending: NativePending,
  token: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
  previousIdentity?: Identity,
): Promise<Identity | null> {
  const id = configuration.providerId;
  if (id === "discord")
    return verifyNativeDiscordIdentity(
      configuration,
      pending,
      token,
      transport,
    );
  if (id === "twitch")
    return verifyNativeTwitchIdentity(configuration, pending, token, transport);
  if (id === "vercel")
    return verifyNativeVercelIdentity(
      configuration,
      pending,
      token,
      transport,
      previousIdentity,
    );
  if (id === "codeberg") return verifyNativeCodebergIdentity(token, transport);
  if (id === "auth0" || id === "okta")
    return verifyNativeTenantOAuthIdentity(
      configuration,
      pending,
      token,
      transport,
      previousIdentity,
    );
  if (id === "databricks")
    return verifyNativeDatabricksIdentity(
      configuration,
      pending,
      token,
      transport,
    );
  if (id !== "crowdin") return null;
  const account = z
    .object({
      data: z.object({
        id: z.number().int().positive(),
        username: z.string().min(1).max(1024),
        fullName: z.string().max(1024).optional(),
      }),
    })
    .parse(
      await nativeApiHttp(
        {
          url: "https://api.crowdin.com/api/v2/user",
          method: "GET",
          headers: new Headers({
            accept: "application/json",
            authorization: `Bearer ${token.accessToken}`,
          }),
        },
        transport,
      ),
    );
  return {
    id: String(account.data.id),
    label: account.data.fullName || account.data.username,
    kind: "account",
    assurance: "account-verified",
  };
}
