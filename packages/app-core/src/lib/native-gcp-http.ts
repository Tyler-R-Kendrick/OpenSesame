/** One bearer-token JSON call to a Google API: bounded, with every failure reduced to a class, never Google's words. */
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { EgressDenied } from "./capabilities/egress.js";
import { NativeApiError } from "./native-api-http.js";
import { readBoundedText } from "./native-bounded-body.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

export async function gcpApiCall(
  transport: NativeProviderTransport,
  token: string,
  method: "GET" | "POST",
  url: string,
  body?: string,
): Promise<Record<string, BoundaryValue>> {
  transport.assertCurrent();
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await transport.fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    transport.assertCurrent();
    if (response.redirected) throw new NativeApiError("response");
    const text = await readBoundedText(response);
    if (response.status === 401) throw new NativeApiError("authorization", 401);
    if (response.status === 403) throw new NativeApiError("permission", 403);
    if (response.status === 429) throw new NativeApiError("rate-limit", 429);
    if (!response.ok) throw new NativeApiError("response", response.status);
    transport.assertCurrent();
    if (controller.signal.aborted) throw new NativeApiError("network");
    const parsed: BoundaryValue = JSON.parse(text);
    if (!isJsonObject(parsed)) throw new NativeApiError("response");
    return parsed;
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    if (error instanceof EgressDenied) throw new NativeApiError("deployment");
    if (error instanceof SyntaxError) throw new NativeApiError("response");
    throw new NativeApiError("network");
  } finally {
    clearTimeout(timeout);
  }
}
