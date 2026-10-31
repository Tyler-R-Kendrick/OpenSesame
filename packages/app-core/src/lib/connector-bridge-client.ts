/**
 * The page's side of the connector bridge (ADR 0199): asking the extension
 * its three questions over a channel, and reading its answers as strictly as
 * the extension reads the asks. The channel is a port, so nothing here touches
 * a browser global; the Pages shell binds the window to it.
 */
import {
  type BridgeErrorCode,
  type BridgeFetchRequest,
  type BridgeFetchResponse,
  type BridgeHello,
  type BridgeOperation,
  type PageRequest,
  REQUEST_TIMEOUT_MS,
  pageRequestMessage,
  parsePageReply,
} from "@opensesame/connector-bridge";
import type { BoundaryValue } from "@opensesame/os-domain";

export type BridgeChannel = {
  /** Post one message toward the extension's relay. */
  post: (message: ReturnType<typeof pageRequestMessage>) => void;
  /** Hear every message that reaches the page; returns how to stop. */
  listen: (handler: (data: BoundaryValue) => void) => () => void;
};

/** A question the bridge did not answer, or refused: its code, or that it never answered. */
export class BridgeCallError extends Error {
  constructor(readonly code: BridgeErrorCode | "unanswered") {
    super(`The connector bridge answered: ${code}`);
    this.name = "BridgeCallError";
  }
}

export type BridgeClientOptions = {
  newId?: () => string;
  /** How long to wait for a hello; a bridge that is not there never answers. */
  helloMs?: number;
  /** How long to wait for a request: the extension's own limit, and a little more. */
  fetchMs?: number;
};

type Waiting = {
  operation: BridgeOperation;
  settle: (reply: ReturnType<typeof parsePageReply>) => void;
};

/** The requests sent and not yet answered, and the one listener that hears their answers. */
function createExchange(channel: BridgeChannel, newId: () => string) {
  const waiting = new Map<string, Waiting>();
  let stop: (() => void) | null = null;
  let draining = false;

  /** Stop listening once nothing is left to hear, when asked to wind down. */
  function settleDrain() {
    if (!draining || waiting.size > 0) return;
    stop?.();
    stop = null;
  }

  function hear(data: BoundaryValue) {
    for (const [id, entry] of waiting) {
      const reply = parsePageReply(data, entry.operation);
      if (reply?.id !== id) continue;
      waiting.delete(id);
      entry.settle(reply);
      settleDrain();
      return;
    }
  }

  function ask(
    build: (id: string) => PageRequest,
    operation: BridgeOperation,
    ms: number,
  ) {
    // A client winding down starts nothing new: its answer would have no one to read it.
    if (draining) return Promise.resolve(null);
    stop ??= channel.listen(hear);
    const id = newId();
    return new Promise<ReturnType<typeof parsePageReply>>((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(null);
        settleDrain();
      }, ms);
      waiting.set(id, {
        operation,
        settle: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
      });
      channel.post(pageRequestMessage(build(id)));
    });
  }

  return {
    ask,
    drain() {
      draining = true;
      settleDrain();
    },
    close() {
      stop?.();
      stop = null;
      for (const entry of waiting.values()) entry.settle(null);
      waiting.clear();
    },
  };
}

export function createBridgeClient(
  channel: BridgeChannel,
  options: BridgeClientOptions = {},
) {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const helloMs = options.helloMs ?? 800;
  const fetchMs = options.fetchMs ?? REQUEST_TIMEOUT_MS + 5_000;
  const exchange = createExchange(channel, newId);
  const ask = exchange.ask;

  /** The bridge and the hosts it holds, or `null` when nothing answers. */
  async function hello(): Promise<BridgeHello | null> {
    const reply = await ask((id) => ({ id, op: "hello" }), "hello", helloMs);
    return reply && "result" in reply && "bridge" in reply.result
      ? reply.result
      : null;
  }

  /** Tell the bridge which hosts a connection needs, so its popup can offer them. */
  async function need(hosts: readonly string[]): Promise<string[]> {
    const reply = await ask(
      (id) => ({ id, op: "need", hosts: [...hosts] }),
      "need",
      helloMs,
    );
    if (!reply) throw new BridgeCallError("unanswered");
    if ("error" in reply) throw new BridgeCallError(reply.error);
    return "pending" in reply.result ? [...reply.result.pending] : [];
  }

  async function send(
    request: BridgeFetchRequest,
  ): Promise<BridgeFetchResponse> {
    const reply = await ask(
      (id) => ({ id, op: "fetch", request }),
      "fetch",
      fetchMs,
    );
    if (!reply) throw new BridgeCallError("unanswered");
    if ("error" in reply) throw new BridgeCallError(reply.error);
    if (!("status" in reply.result)) throw new BridgeCallError("unanswered");
    return reply.result;
  }

  return {
    hello,
    need,
    fetch: send,
    /**
     * Wind down without losing a request already sent: a token exchange the
     * extension is still carrying must be read when it lands, so it can be
     * sealed and cleaned up (ADR 0185 §8). New requests are refused; the
     * channel is let go when the last answer, or its timeout, arrives.
     */
    drain: exchange.drain,
    close: exchange.close,
  };
}

export type BridgeClient = ReturnType<typeof createBridgeClient>;
