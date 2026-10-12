import type { BoundaryValue } from "@opensesame/os-domain";
/** Public Sign in with Vercel grants identify an account, not Vercel Connect access. */
import { sha256Base64Url } from "@opensesame/sdk-browser";
import { z } from "zod";
import {
  type NativePending,
  NativePendingSchema,
} from "./native-connector-schema.js";
import { NativeOAuthError } from "./native-oauth-errors.js";

export const NATIVE_VERCEL_ISSUER = "https://vercel.com";
export const NATIVE_VERCEL_TOKEN = "https://api.vercel.com/login/oauth/token";
export const NATIVE_VERCEL_USERINFO =
  "https://api.vercel.com/login/oauth/userinfo";
export const NATIVE_VERCEL_REVOCATION =
  "https://api.vercel.com/login/oauth/token/revoke";
export const NATIVE_VERCEL_IDENTITY_SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
] as const;

const message = z
  .object({
    state: z.string().min(32).max(512),
    code: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[!-~]+$/)
      .optional(),
    error: z.string().min(1).max(256).optional(),
  })
  .refine((value) => Boolean(value.code) !== Boolean(value.error));

/** The browser transport separately pins the exact popup source and Vercel origin. */
export function parseNativeVercelWebMessage(data: BoundaryValue): {
  state: string;
  code: string | null;
  error: boolean;
} | null {
  const parsed = message.safeParse(data);
  return parsed.success
    ? {
        state: parsed.data.state,
        code: parsed.data.code ?? null,
        error: Boolean(parsed.data.error),
      }
    : null;
}

function assertVercelPending(pending: NativePending): void {
  NativePendingSchema.parse(pending);
  if (
    pending.providerId !== "vercel" ||
    pending.actor !== "user" ||
    pending.issuer !== NATIVE_VERCEL_ISSUER ||
    pending.endpoint !== NATIVE_VERCEL_TOKEN ||
    !pending.clientId ||
    !pending.scopes.includes("openid") ||
    pending.scopes.some(
      (scope) =>
        !NATIVE_VERCEL_IDENTITY_SCOPES.some((allowed) => allowed === scope),
    )
  )
    throw new NativeOAuthError("provider");
}
function secureVercelRedirect(value: string): URL {
  const redirect = new URL(value);
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
    throw new NativeOAuthError("callback");
  return redirect;
}
export async function nativeVercelAuthorizationUrl(
  pending: NativePending,
  mode: "query" | "web_message.opener",
): Promise<string> {
  assertVercelPending(pending);
  const redirect = secureVercelRedirect(pending.redirectUri);
  const url = new URL("https://vercel.com/oauth/authorize");
  const query = {
    response_type: "code",
    response_mode: mode,
    client_id: pending.clientId ?? "",
    redirect_uri: redirect.href,
    state: pending.state,
    nonce: pending.state,
    code_challenge: await sha256Base64Url(pending.verifier),
    code_challenge_method: "S256",
    scope: pending.scopes.join(" "),
  };
  for (const [name, value] of Object.entries(query))
    url.searchParams.set(name, value);
  return url.href;
}
