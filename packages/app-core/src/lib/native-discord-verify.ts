/** Discord's approved implicit token must belong to this app and a real user. */
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
export async function verifyNativeDiscordIdentity(
  configuration: NativeConfiguration,
  pending: NativePending,
  token: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
): Promise<NonNullable<NativeRuntime["identity"]>> {
  if (
    configuration.providerId !== "discord" ||
    pending.providerId !== "discord" ||
    pending.clientId !== configuration.clientId ||
    pending.issuer !== "https://discord.com" ||
    pending.endpoint !== "https://discord.com/api/oauth2/token"
  )
    throw new NativeOAuthError("provider");
  const headers = new Headers({
    authorization: `Bearer ${token.accessToken}`,
    accept: "application/json",
  });
  const auth = z
    .object({
      application: z.object({ id: z.string().min(1).max(256) }),
      scopes: z.array(z.string().min(1).max(512)).max(256),
      expires: z.string().datetime({ offset: true }),
      user: z.object({ id: z.string().min(1).max(256) }).optional(),
    })
    .parse(
      await nativeApiHttp(
        {
          url: "https://discord.com/api/v10/oauth2/@me",
          method: "GET",
          headers,
        },
        transport,
      ),
    );
  if (
    auth.application.id !== configuration.clientId ||
    !auth.user ||
    Date.parse(auth.expires) <= Date.now() ||
    pending.scopes.some((scope) => !auth.scopes.includes(scope)) ||
    token.scopes?.some((scope) => !auth.scopes.includes(scope))
  )
    throw new NativeOAuthError("provider");
  const user = z
    .object({
      id: z.string().min(1).max(256),
      username: z.string().min(1).max(1024),
      global_name: z.string().max(1024).nullable().optional(),
    })
    .parse(
      await nativeApiHttp(
        {
          url: "https://discord.com/api/v10/users/@me",
          method: "GET",
          headers,
        },
        transport,
      ),
    );
  if (user.id !== auth.user.id) throw new NativeOAuthError("provider");
  safeProviderText(user.id, { access: token.accessToken });
  safeProviderText(user.global_name || user.username, {
    access: token.accessToken,
  });
  return {
    id: user.id,
    label: user.global_name || user.username,
    kind: "account",
    assurance: "account-verified",
  };
}
