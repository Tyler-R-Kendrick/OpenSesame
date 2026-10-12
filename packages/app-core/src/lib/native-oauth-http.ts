/** OAuth credential mutation replies must survive a stale lease so they can be journaled. */
import type { BoundaryValue } from "@opensesame/os-domain";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";

export type NativeOAuthHttpReply = { status: number; body: BoundaryValue };
async function boundedOAuthBody(
  response: Response,
  signal: AbortSignal,
): Promise<BoundaryValue> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 256 * 1024) throw new NativeOAuthError("provider");
      chunks.push(part.value);
    }
    if (size === 0) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const result: BoundaryValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return result;
  } catch {
    throw new NativeOAuthError("provider");
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
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
