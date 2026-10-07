import {
  ExtensionRealmBroker,
  type SecurityRequest,
} from "@opensesame/app-core/browser/security/broker.js";
import type { PagePort } from "@opensesame/app-core/browser/security/client.js";
import type { BoundaryValue } from "@opensesame/os-domain";

/** Real broker protocol for the bare-install options fixture. */
export function memorySecurityPort(): PagePort {
  const broker = new ExtensionRealmBroker({
    revision: async () => null,
    classify: async () => {
      throw new Error("No protected vault in this fixture.");
    },
    now: Date.now,
  });
  const session = broker.attach();
  let listener: (reply: BoundaryValue) => void = () => undefined;
  return {
    postMessage: (request: SecurityRequest) => {
      void session.handle(request).then((reply) => listener(reply));
    },
    onMessage: {
      addListener: (receive) => {
        listener = receive;
      },
    },
    onDisconnect: { addListener: () => undefined },
  };
}
