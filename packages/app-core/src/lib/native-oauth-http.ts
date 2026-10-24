/** OAuth credential mutation replies must survive a stale lease so they can be journaled. */
import type { BoundaryValue } from "@opensesame/os-domain";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeResponseJson } from "./native-response-json.js";

export type NativeOAuthHttpReply = { status: number; body: BoundaryValue };
async function boundedOAuthBody(
  response: Response,
  signal: AbortSignal,
): Promise<BoundaryValue> {
  try {
    return await nativeResponseJson(response, {
      maxBytes: 256 * 1024,
      signal,
      fatalUtf8: true,
      empty: "null",
    });
  } catch {
    throw new NativeOAuthError("provider");
  }
}
export async function nativeOAuthHttp(
  url: string,
  body: URLSearchParams | string,
  transport: NativeProviderTransport,
  bearer?: string,
  credentialMutation = true,
): Promise<NativeOAuthHttpReply> {
  transport.assertCurrent();
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.hash ||
    target.search
  )
    throw new NativeOAuthError("provider");
  const deadline = AbortSignal.timeout(15_000);
  const headers = new Headers({
    accept: "application/json",
    "content-type":
      body instanceof URLSearchParams
        ? "application/x-www-form-urlencoded"
        : "application/json",
  });
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  try {
    const send = credentialMutation
      ? (transport.settleCredentialMutation ?? transport.fetch)
      : transport.fetch;
    const response = await send(target, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: deadline,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    if (response.redirected) throw new NativeOAuthError("provider");
    return {
      status: response.status,
      body: await boundedOAuthBody(response, deadline),
    };
  } catch (error) {
    if (error instanceof NativeOAuthError) throw error;
    throw new NativeOAuthError("network");
  }
}
