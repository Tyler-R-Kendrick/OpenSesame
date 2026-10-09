/** Twitch's official public-client device flow never sends a client secret. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import type { IssuedNativeOAuthToken } from "./native-browser-oauth-token.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeOAuthHttp } from "./native-oauth-http.js";

const opaque = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[!-~]+$/);
const Device = z.object({
  device_code: z
    .string()
    .min(16)
    .max(96)
    .regex(/^[!-~]+$/),
  user_code: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9-]+$/),
  expires_in: z.number().int().positive().max(1800),
  interval: z.number().int().positive().max(60),
  verification_uri: z.string().max(1024),
});
export type NativeTwitchDeviceChallenge = z.infer<typeof Device>;
export async function requestNativeTwitchDevice(
  clientId: string,
  scopes: readonly string[],
  transport: NativeProviderTransport,
): Promise<NativeTwitchDeviceChallenge> {
  const reply = await nativeOAuthHttp(
    "https://id.twitch.tv/oauth2/device",
    new URLSearchParams({ client_id: clientId, scopes: scopes.join(" ") }),
    transport,
    undefined,
    false,
  );
  transport.assertCurrent();
  const parsed = Device.safeParse(reply.body);
  if (reply.status !== 200 || !parsed.success)
    throw new NativeOAuthError("provider");
  const challenge = parsed.data;
  return { ...challenge, verification_uri: twitchVerificationUri(challenge) };
}
const Pair = z.object({
  access_token: opaque,
  refresh_token: opaque.optional(),
});
const Access = z.object({ access_token: opaque });
const Details = z.object({
  token_type: z.string(),
  expires_in: z
    .number()
    .finite()
    .positive()
    .max(365 * 86400),
  scope: z.array(z.string().min(1).max(512)).max(256),
});
/** Retain recognizable credentials even if the provider's remaining protocol fields are invalid. */
export function parseNativeTwitchDeviceToken(
  body: BoundaryValue,
): IssuedNativeOAuthToken {
  const pair = Pair.safeParse(body);
  if (!pair.success) {
    const access = Access.safeParse(body);
    if (!access.success) throw new NativeOAuthError("provider");
    return {
      accessToken: access.data.access_token,
      expiresAt: null,
      scopes: null,
      protocolValid: false,
    };
  }
  const details = Details.safeParse(body);
  return {
    accessToken: pair.data.access_token,
    refreshToken: pair.data.refresh_token,
    expiresAt: details.success
      ? Date.now() + details.data.expires_in * 1000
      : null,
    scopes: details.success ? [...new Set(details.data.scope)] : null,
    protocolValid:
      details.success &&
      details.data.token_type.toLowerCase() === "bearer" &&
      !!pair.data.refresh_token,
  };
}
export type NativeTwitchPollReply =
  | { kind: "pending" | "slow-down" }
  | { kind: "token"; token: IssuedNativeOAuthToken };
export async function pollNativeTwitchDevice(
  clientId: string,
  scopes: readonly string[],
  deviceCode: string,
  transport: NativeProviderTransport,
): Promise<NativeTwitchPollReply> {
  const reply = await nativeOAuthHttp(
    "https://id.twitch.tv/oauth2/token",
    new URLSearchParams({
      client_id: clientId,
      scopes: scopes.join(" "),
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    transport,
  );
  if (Access.safeParse(reply.body).success) {
    const token = parseNativeTwitchDeviceToken(reply.body);
    token.protocolValid =
      token.protocolValid && reply.status >= 200 && reply.status < 300;
    return { kind: "token", token };
  }
  const failure = z
    .object({
      error: z.string().max(128).optional(),
      message: z.string().max(128).optional(),
    })
    .safeParse(reply.body);
  if (!failure.success || (reply.status >= 200 && reply.status < 300))
    throw new NativeOAuthError("provider");
  const reason = failure.data.error ?? failure.data.message;
  if (reason === "authorization_pending") return { kind: "pending" };
  if (reason === "slow_down") return { kind: "slow-down" };
  if (reason === "access_denied") throw new NativeOAuthError("denied");
  if (["expired_token", "invalid device code"].includes(reason ?? ""))
    throw new NativeOAuthError("expired");
  throw new NativeOAuthError("provider");
}

function twitchVerificationUri(challenge: NativeTwitchDeviceChallenge): string {
  let verification: URL;
  try {
    verification = new URL(challenge.verification_uri);
  } catch {
    throw new NativeOAuthError("provider");
  }
  const parameters = verification.searchParams;
  if (
    verification.origin !== "https://www.twitch.tv" ||
    verification.pathname !== "/activate" ||
    verification.username ||
    verification.password ||
    verification.hash ||
    [...parameters.keys()].some(
      (key) => !["public", "device-code"].includes(key),
    )
  )
    throw new NativeOAuthError("provider");
  if (
    parameters.getAll("public").length > 1 ||
    parameters.getAll("device-code").length > 1 ||
    (parameters.has("public") && parameters.get("public") !== "true") ||
    (parameters.has("device-code") &&
      parameters.get("device-code") !== challenge.user_code)
  )
    throw new NativeOAuthError("provider");
  // Twitch documents these public-client prefill fields; show the code on its actual approval page.
  parameters.set("public", "true");
  parameters.set("device-code", challenge.user_code);
  return verification.toString();
}
