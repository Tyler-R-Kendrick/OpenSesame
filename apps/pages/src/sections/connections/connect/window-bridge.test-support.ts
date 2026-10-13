/**
 * The extension's relay, in a function, for tests that render the app: it hears
 * the messages the page posts to its own window and answers them the way the
 * relay does. jsdom stamps no `source` or `origin` on a posted message, so the
 * answers are dispatched with them set, as a browser would.
 */
import {
  type BridgeFetchRequest,
  type BridgeFetchResponse,
  type PageRequest,
  pageReplyMessage,
  parsePageRequest,
} from "@opensesame/connector-bridge";

export type WindowBridgeOptions = {
  granted: string[];
  onFetch?: (
    request: BridgeFetchRequest,
  ) => BridgeFetchResponse | { error: "not_granted" | "network" };
};

export function installWindowBridge(options: WindowBridgeOptions) {
  const heard: PageRequest[] = [];
  const reply = (request: PageRequest) => {
    if (request.op === "hello")
      return {
        id: request.id,
        result: {
          bridge: "opensesame-connector-bridge" as const,
          version: "0.1.0",
          granted: options.granted,
        },
      };
    if (request.op === "need")
      return { id: request.id, result: { pending: [...request.hosts] } };
    const answer = options.onFetch?.(request.request) ?? {
      status: 200,
      headers: [],
      body: "{}",
    };
    return "error" in answer
      ? { id: request.id, error: answer.error }
      : { id: request.id, result: answer };
  };
  const hear = (event: MessageEvent) => {
    const request = parsePageRequest(event.data);
    if (!request) return;
    heard.push(request);
    queueMicrotask(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: pageReplyMessage(reply(request)),
          source: window,
          origin: window.location.origin,
        }),
      ),
    );
  };
  window.addEventListener("message", hear);
  return {
    heard,
    remove: () => window.removeEventListener("message", hear),
  };
}
