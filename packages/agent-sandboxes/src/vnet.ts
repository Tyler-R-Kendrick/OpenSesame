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

export type VirtualFetch = (
  request: VirtualFetchRequest,
) => Promise<VirtualFetchResponse>;

export const virtualFetchRequestSchema = z.object({
  sessionId: z.string().min(1),
  url: z.string().url(),
  method: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

const virtualFetchResponseSchema = z.object({
  status: z.number(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  bodyText: z.string(),
});

/** HTTP client side of the virtual-network relay (global `fetch` only). */
export function virtualFetchOverHttp(
  relayUrl: string,
  token: string,
): VirtualFetch {
  const endpoint = `${relayUrl.replace(/\/$/u, "")}/fetch`;
  return async (request) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    if (!response.ok)
      throw new Error(`virtual network relay refused (${response.status})`);
    return virtualFetchResponseSchema.parse(await response.json());
  };
}
