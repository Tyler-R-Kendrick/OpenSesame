/**
 * Virtualized networking for the WASM lane.
 *
 * A WASM/browser-hosted DOM driver cannot open sockets to the target site
 * (no raw TCP, and the same-origin policy stands in the way), so every
 * fetch it makes is an RPC to a relay: the relay performs the real request
 * (cookies and redirects included, per session) and returns the final
 * response. The driver only ever talks to its relay; the relay is the
 * only party that sees the target site, which is why it must be
 * user-controlled infrastructure, never a shared public proxy.
 */

import { z } from "zod";

export interface VirtualFetchRequest {
  sessionId: string;
  url: string;
  method: string;
  /** Immutable origins authorized for this session by the caller. */
  allowedOrigins?: readonly string[] | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}

export interface VirtualFetchResponse {
  status: number;
  /** Final URL after relay-side redirect following. */
  url: string;
  headers: Record<string, string>;
  bodyText: string;
}

export type VirtualFetch = ((
  request: VirtualFetchRequest,
) => Promise<VirtualFetchResponse>) & {
  closeSession?: (sessionId: string) => Promise<void>;
};

export const virtualFetchRequestSchema = z.object({
  sessionId: z.string().min(1).max(128),
  url: z.string().url().max(2048),
  method: z.enum(["GET", "HEAD", "POST"]),
  allowedOrigins: z.array(z.string().url().max(2048)).min(1).max(32).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

const virtualFetchResponseSchema = z.object({
  status: z.number(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  bodyText: z.string(),
});

const relayJarSchema = z.record(z.string(), z.record(z.string(), z.string()));

const relayFetchResponseSchema = virtualFetchResponseSchema.extend({
  jar: relayJarSchema.optional(),
});

type RelayJar = z.infer<typeof relayJarSchema>;

/** HTTP client side of the virtual-network relay (global `fetch` only). */
export function virtualFetchOverHttp(
  relayUrl: string,
  token: string,
): VirtualFetch {
  const base = new URL(relayUrl);
  const loopback = ["127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) ||
    !token
  )
    throw new Error(
      "virtual network relay requires HTTPS or loopback HTTP and a token",
    );
  const endpoint = base.href.replace(/\/$/u, "");
  const sessionJars = new Map<string, RelayJar>();
  const send = async (
    path: "/fetch" | "/close",
    body:
      | VirtualFetchRequest
      | { sessionId: string }
      | (VirtualFetchRequest & { jar: RelayJar }),
  ) => {
    const response = await fetch(`${endpoint}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`virtual network relay refused (${response.status})`);
    return response;
  };
  const virtualFetch: VirtualFetch = async (request) => {
    const payload = {
      ...request,
      jar: sessionJars.get(request.sessionId) ?? {},
    };
    const parsed = relayFetchResponseSchema.parse(
      await (await send("/fetch", payload)).json(),
    );
    if (parsed.jar) sessionJars.set(request.sessionId, parsed.jar);
    return {
      status: parsed.status,
      url: parsed.url,
      headers: parsed.headers,
      bodyText: parsed.bodyText,
    };
  };
  virtualFetch.closeSession = async (sessionId) => {
    await send("/close", { sessionId });
    sessionJars.delete(sessionId);
  };
  return virtualFetch;
}
