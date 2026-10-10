/** Secretless provider token protocols, including OpenRouter's key authorization. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  type NativeBrowserOAuthProfile,
  browserOAuthEndpoints,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import type {
  NativeConfiguration,
  NativePending,
} from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeOAuthHttp } from "./native-oauth-http.js";
import { parseNativeTwitchDeviceToken } from "./native-twitch-device-http.js";

const opaque = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[!-~]+$/);
const PairSchema = z.object({
  access_token: opaque,
  refresh_token: opaque.optional(),
});
const AccessSchema = z.object({ access_token: opaque });
const DetailsSchema = z.object({
  token_type: z.string().optional(),
  expires_in: z
    .number()
    .finite()
    .positive()
    .max(365 * 86400)
    .optional(),
  scope: z
    .string()
    .max(32768)
    .refine((value) => {
      const scopes = value.split(/\s+/).filter(Boolean);
      return (
        scopes.length <= 256 && scopes.every((scope) => scope.length <= 512)
      );
    })
    .optional(),
  id_token: opaque.optional(),
});
export type IssuedNativeOAuthToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
  scopes: string[] | null;
  idToken?: string;
  protocolValid: boolean;
};
function parseAuthorizedKey(body: BoundaryValue): IssuedNativeOAuthToken {
  const parsed = z.object({ key: opaque }).safeParse(body);
  if (!parsed.success) throw new NativeOAuthError("provider");
  return {
    accessToken: parsed.data.key,
    expiresAt: null,
    scopes: null,
    protocolValid: true,
  };
}
function validTokenDetails(
  data: z.infer<typeof DetailsSchema> | null,
  refreshToken: string | undefined,
  profile: NativeBrowserOAuthProfile,
): boolean {
  if (!data || data.expires_in === undefined) return false;
  return (
    data.token_type?.toLowerCase() === "bearer" &&
    (profile.refresh || !refreshToken)
  );
}
function tokenDetails(
  pair: z.infer<typeof PairSchema>,
  data: z.infer<typeof DetailsSchema> | null,
  profile: NativeBrowserOAuthProfile,
): IssuedNativeOAuthToken {
  return {
    accessToken: pair.access_token,
    refreshToken: pair.refresh_token,
    expiresAt: data?.expires_in ? Date.now() + data.expires_in * 1000 : null,
    scopes:
      data?.scope === undefined
        ? null
        : [...new Set(data.scope.split(/\s+/).filter(Boolean))],
    idToken: data?.id_token,
    protocolValid: validTokenDetails(data, pair.refresh_token, profile),
  };
}
export function parseNativeOAuthToken(
  body: BoundaryValue,
  profile: NativeBrowserOAuthProfile,
): IssuedNativeOAuthToken {
  if (profile.mode === "openrouter-key") return parseAuthorizedKey(body);
  if (profile.id === "twitch") return parseNativeTwitchDeviceToken(body);
  const pair = PairSchema.safeParse(body);
  if (!pair.success) {
    const access = AccessSchema.safeParse(body);
    if (!access.success) throw new NativeOAuthError("provider");
    return tokenDetails(access.data, null, profile);
  }
  const details = DetailsSchema.safeParse(body);
  return tokenDetails(
    pair.data,
    details.success ? details.data : null,
    profile,
  );
}
export async function exchangeNativeBrowserCode(
  configuration: NativeConfiguration,
  pending: NativePending,
  code: string,
  transport: NativeProviderTransport,
): Promise<IssuedNativeOAuthToken> {
  const profile = requiredBrowserOAuthProfile(configuration.providerId);
  const endpoint = browserOAuthEndpoints(profile, configuration).token;
  if (pending.endpoint !== endpoint) throw new NativeOAuthError("expired");
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: pending.clientId ?? "",
    redirect_uri: pending.redirectUri,
    code,
    code_verifier: pending.verifier,
  });
  const body =
    profile.mode === "openrouter-key"
      ? JSON.stringify({
          code,
          code_verifier: pending.verifier,
          code_challenge_method: "S256",
        })
      : form;
  const reply = await nativeOAuthHttp(endpoint, body, transport);
  const token = parseNativeOAuthToken(reply.body, profile);
  return {
    ...token,
    protocolValid:
      token.protocolValid && reply.status >= 200 && reply.status < 300,
  };
}
export async function refreshNativeBrowserToken(
  configuration: NativeConfiguration,
  refreshToken: string,
  transport: NativeProviderTransport,
): Promise<IssuedNativeOAuthToken> {
  const profile = requiredBrowserOAuthProfile(configuration.providerId);
  if (!profile.refresh) throw new NativeOAuthError("expired");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: configuration.clientId ?? "",
    refresh_token: refreshToken,
  });
  const reply = await nativeOAuthHttp(
    browserOAuthEndpoints(profile, configuration).token,
    body,
    transport,
  );
  if (reply.status < 200 || reply.status >= 300) {
    const error = z
      .object({ error: z.literal("invalid_grant") })
      .safeParse(reply.body);
    if (AccessSchema.safeParse(reply.body).success)
      return {
        ...parseNativeOAuthToken(reply.body, profile),
        protocolValid: false,
      };
    throw new NativeOAuthError(
      "provider",
      reply.status === 400 && error.success ? "invalid_grant" : undefined,
    );
  }
  return parseNativeOAuthToken(reply.body, profile);
}
