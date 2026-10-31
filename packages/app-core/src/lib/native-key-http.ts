/** One JSON call to a key-driven provider's API: bounded, with every failure reduced to a class, never the provider's words. */
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { EgressDenied } from "./capabilities/egress.js";
import { NativeApiError } from "./native-api-http.js";
import { readBoundedText } from "./native-bounded-body.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

/** Every status a provider can answer with, reduced to a class of failure. */
function assertAccepted(response: Response): void {
  const { status } = response;
  if (status === 401) throw new NativeApiError("authorization", 401);
  if (status === 403) throw new NativeApiError("permission", 403);
  if (status === 429) throw new NativeApiError("rate-limit", 429);
  if (!response.ok) throw new NativeApiError("response", status);
}

export type KeyBody =
  | { kind: "json"; value: BoundaryValue }
  | { kind: "form"; value: URLSearchParams };

const contentType = (body: KeyBody) =>
  body.kind === "json"
    ? "application/json"
    : "application/x-www-form-urlencoded";

const encoded = (body: KeyBody | undefined) => {
  if (body === undefined) return undefined;
  return body.kind === "json"
    ? JSON.stringify(body.value)
    : body.value.toString();
};

/** The text of an answer as a JSON object; an action that succeeds may answer with nothing at all. */
function parsedObject(text: string): Record<string, BoundaryValue> {
  if (text.trim() === "") return {};
  const parsed: BoundaryValue = JSON.parse(text);
  if (!isJsonObject(parsed)) throw new NativeApiError("response");
  return parsed;
}

export type KeyCallOptions = {
  headers?: Readonly<Record<string, string>>;
  /** The largest answer read, up to the bridge's own 1 MiB. */
  limit?: number;
};

export async function keyCall(
  transport: NativeProviderTransport,
  method: "GET" | "POST" | "DELETE",
  url: string,
  token?: string,
  body?: KeyBody,
  options: KeyCallOptions = {},
): Promise<Record<string, BoundaryValue>> {
  transport.assertCurrent();
  const headers = new Headers({ Accept: "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  for (const [name, value] of Object.entries(options.headers ?? {}))
    headers.set(name, value);
  if (body) headers.set("Content-Type", contentType(body));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await transport.fetch(url, {
      method,
      headers,
      body: encoded(body),
      signal: controller.signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    transport.assertCurrent();
    if (response.redirected) throw new NativeApiError("response");
    const text = await readBoundedText(response, options.limit);
    assertAccepted(response);
    transport.assertCurrent();
    if (controller.signal.aborted) throw new NativeApiError("network");
    return parsedObject(text);
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    if (error instanceof EgressDenied) throw new NativeApiError("deployment");
    if (error instanceof SyntaxError) throw new NativeApiError("response");
    throw new NativeApiError("network");
  } finally {
    clearTimeout(timeout);
  }
}
