/** A bridge in a function, for tests of the page's side: it answers the three questions the way the extension does, over a channel the client can use. */
import {
  type BridgeFetchRequest,
  type BridgeFetchResponse,
  type PageRequest,
  pageReplyMessage,
  parsePageRequest,
} from "@opensesame/connector-bridge";
import type { BoundaryValue } from "@opensesame/os-domain";
import type { BridgeChannel } from "./connector-bridge-client.js";

export type FakeBridgeOptions = {
  /** Hosts the person allowed. */
  granted?: string[];
  /** Whether anything answers at all. */
  silent?: boolean;
  /** What a fetch gives back, or the refusal code. */
  onFetch?: (
    request: BridgeFetchRequest,
  ) =>
    | BridgeFetchResponse
    | { error: "not_granted" | "host_not_allowed" | "network" | "timeout" };
  version?: string;
};

export function fakeBridge(options: FakeBridgeOptions = {}) {
  const heard: PageRequest[] = [];
  const handlers = new Set<(data: BoundaryValue) => void>();
  const answer = (request: PageRequest) => {
    if (request.op === "hello")
      return {
        id: request.id,
        result: {
          bridge: "opensesame-connector-bridge" as const,
          version: options.version ?? "0.1.0",
          granted: options.granted ?? [],
        },
      };
    if (request.op === "need")
      return { id: request.id, result: { pending: [...request.hosts] } };
    const reply = options.onFetch?.(request.request) ?? {
      status: 200,
      headers: [],
      body: "{}",
    };
    return "error" in reply
      ? { id: request.id, error: reply.error }
      : { id: request.id, result: reply };
  };
  const channel: BridgeChannel = {
    post(message) {
      const request = parsePageRequest(message);
      if (!request) return;
      heard.push(request);
      if (options.silent) return;
      queueMicrotask(() => {
        const reply = pageReplyMessage(answer(request));
        for (const handler of [...handlers]) handler(reply);
      });
    },
    listen(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  return { channel, heard, handlers };
}
