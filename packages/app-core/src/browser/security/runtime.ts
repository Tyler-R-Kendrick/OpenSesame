import type { BoundaryValue } from "@opensesame/os-domain";
import {
  ExtensionRealmBroker,
  SECURITY_PORT,
  type SecurityReply,
  securityRequest,
} from "./broker.js";
import { classifyExtensionPassword, extensionVaultRevision } from "./core.js";
import { manageExtensionSecurity } from "./management.js";

export type SecurityPort = {
  name: string;
  sender?: { id?: string; url?: string; tab?: object };
  postMessage(message: SecurityReply): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: BoundaryValue) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};
export type SecurityRuntime = {
  id: string;
  getURL(path: string): string;
  onConnect: { addListener(listener: (port: SecurityPort) => void): void };
};
/** The browser supplies the port identity; content scripts cannot open owner sessions. */
export function installSecurityBroker(runtime: SecurityRuntime) {
  const broker = new ExtensionRealmBroker({
    revision: extensionVaultRevision,
    classify: classifyExtensionPassword,
    now: Date.now,
    manage: manageExtensionSecurity,
  });
  runtime.onConnect.addListener((port) => {
    if (port.name !== SECURITY_PORT) return;
    if (
      port.sender?.id !== runtime.id ||
      !port.sender.url?.startsWith(runtime.getURL(""))
    ) {
      port.disconnect();
      return;
    }
    const client = broker.attach();
    port.onDisconnect.addListener(client.close);
    port.onMessage.addListener((message) => {
      const request = securityRequest.safeParse(message);
      if (!request.success) {
        port.disconnect();
        client.close();
        return;
      }
      void client.handle(request.data).then(
        (reply) => {
          try {
            port.postMessage(reply);
          } catch {
            client.close();
          }
        },
        () => {
          client.close();
          port.disconnect();
        },
      );
    });
  });
  return broker;
}
