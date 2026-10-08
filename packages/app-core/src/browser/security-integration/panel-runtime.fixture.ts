import type { BoundaryValue } from "@opensesame/os-domain";
import {
  SECURITY_PORT,
  type SecurityReply,
  securityRequest,
} from "../security/broker.js";
import { securityClient } from "../security/client.js";
import {
  type SecurityPort,
  installSecurityBroker,
} from "../security/runtime.js";
import { CompletionGroup, completionSignal } from "./completion-support.js";

class BrowserPort {
  readonly pending = new Set<number>();
  readonly replies: SecurityReply[] = [];
  readonly waiting: SecurityReply[] = [];
  readonly sent: BoundaryValue[] = [];
  readonly disconnected: Array<() => void> = [];
  #closed = false;
  #hold = false;
  #heldReply: ReturnType<typeof completionSignal> | undefined;
  #failReplies = false;
  #message: (input: BoundaryValue) => void = () => {};
  #pageMessage: (input: BoundaryValue) => void = () => {};
  readonly page = {
    postMessage: (input: BoundaryValue) => {
      if (this.#closed) throw new Error("Browser port disconnected");
      const request = securityRequest.safeParse(input);
      if (request.success) this.pending.add(request.data.id);
      this.sent.push(input);
      this.#message(input);
    },
    onMessage: {
      addListener: (listener: (input: BoundaryValue) => void) => {
        this.#pageMessage = listener;
      },
    },
    onDisconnect: {
      addListener: (listener: () => void) => this.disconnected.push(listener),
    },
  };
  constructor(
    connected: (port: SecurityPort) => void,
    name: string,
    sender: SecurityPort["sender"],
  ) {
    connected({
      name,
      sender,
      disconnect: this.close,
      onDisconnect: {
        addListener: (listener) => this.disconnected.push(listener),
      },
      onMessage: {
        addListener: (listener) => {
          this.#message = listener;
        },
      },
      postMessage: (reply) => {
        this.pending.delete(reply.id);
        if (this.#closed || this.#failReplies)
          throw new Error("Browser transport closed");
        this.replies.push(reply);
        if (this.#hold) {
          this.waiting.push(reply);
          this.#heldReply?.finish();
        } else this.#pageMessage(reply);
      },
    });
  }
  closed = () => this.#closed;
  hold = () => {
    this.#hold = true;
    this.#heldReply = completionSignal();
    return this.#heldReply.promise;
  };
  failReplies = () => {
    this.#failReplies = true;
  };
  close = () => {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.disconnected) listener();
  };
  release() {
    this.#hold = false;
    for (const reply of this.waiting.splice(0)) this.#pageMessage(reply);
  }
}
/** Only browser port transport is doubled; classification, proofs and storage are real. */
export function panelRuntime() {
  let connected: (port: SecurityPort) => void = () => {};
  const runtime = {
    id: "trusted-extension",
    getURL: (path: string) => `chrome-extension://trusted-extension/${path}`,
    onConnect: {
      addListener: (listener: (port: SecurityPort) => void) => {
        connected = listener;
      },
    },
  };
  const broker = installSecurityBroker(runtime);
  const work = new CompletionGroup();
  const attach = broker.attach.bind(broker);
  // Observe real handler promises, including rejected work with no port reply.
  // Disconnect revokes authority; it does not mean its crypto has settled.
  broker.attach = () => {
    const client = attach();
    return {
      ...client,
      handle: (input) => work.track(client.handle(input)),
    };
  };
  const ports: BrowserPort[] = [];
  const open = (name: string, sender: SecurityPort["sender"]) => {
    const port = new BrowserPort(connected, name, sender);
    ports.push(port);
    return port;
  };
  const transport = open(SECURITY_PORT, {
    id: runtime.id,
    url: runtime.getURL("security.html"),
  });
  const client = securityClient({ connect: () => transport.page }, () => {});
  return {
    client,
    broker,
    transport,
    open,
    close() {
      for (const port of ports) {
        port.close();
        port.release();
      }
    },
    drain: () => work.drain(),
  };
}
