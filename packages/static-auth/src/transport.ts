import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { canonicalizeBrowserOrigin } from "@opensesame/sdk-browser";

export function exactOrigin(raw: string): string {
  const origin = canonicalizeBrowserOrigin(raw);
  if (origin !== raw) throw new Error("invalid_origin");
  return origin;
}

export function isLoopbackOrigin(raw: string): boolean {
  try {
    const url = new URL(exactOrigin(raw));
    return (
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

export function endpoint(raw: string, issuer?: string): string {
  const url = new URL(raw);
  exactOrigin(url.origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (issuer && url.origin !== new URL(issuer).origin)
  ) {
    throw new Error("invalid_endpoint");
  }
  return url.href;
}

/** Bounds the entire fetch and stream, not merely response headers. */
export async function fetchJson(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      ...init,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok || response.redirected || !response.body)
      throw new Error("verification_unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 65536) throw new Error("response_too_large");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel();
    }
    const body: BoundaryValue = JSON.parse(text);
    if (!isJsonObject(body)) throw new Error("invalid_response");
    return body;
  } catch {
    throw new Error("verification_failed");
  } finally {
    clearTimeout(timer);
  }
}
