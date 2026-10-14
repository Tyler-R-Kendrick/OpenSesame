import {
  TAILSCALE_BROWSER_NODE_PURPOSE,
  TAILSCALE_BROWSER_PEER_PURPOSE,
} from "@opensesame/app-core/lib/capabilities/catalog-optional-services.js";
import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { bindTailscaleBrowserNode } from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Activation } from "../../activation.js";
import { createBrowserNodeController } from "./controller.js";
export function bindTailscaleBrowserRuntime(
  ctx: ApprovedCapabilityContext,
  activation: Activation,
): void {
  const assertCurrent = () => {
    if (ctx.lease.signal.aborted || activation.disposed())
      throw new Error("Enable Networking to connect a browser node.");
  };
  const node = createBrowserNodeController({
    assertCurrent,
    approve: (href, method) => {
      assertCurrent();
      const url = new URL(href);
      if (method === "CONNECT") {
        if (!["wss:", "ws:"].includes(url.protocol)) return false;
        url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      } else if (!["https:", "http:"].includes(url.protocol)) return false;
      return ctx.egress.decide(url, {
        capability: "networking.tailnet",
        purpose: TAILSCALE_BROWSER_NODE_PURPOSE,
      }).ok;
    },
    approvePeer: (href) => {
      assertCurrent();
      return ctx.egress.decide(href, {
        capability: "networking.tailnet",
        purpose: TAILSCALE_BROWSER_PEER_PURPOSE,
        class: "peer-or-local-network",
      }).ok;
    },
  });
  const release = bindTailscaleBrowserNode(node);
  const releaseLock = vaultStore.onLock(() => node.stop());
  const onAbort = () => node.stop();
  ctx.lease.signal.addEventListener("abort", onAbort, { once: true });
  activation.onDispose(() => {
    ctx.lease.signal.removeEventListener("abort", onAbort);
    node.stop();
    releaseLock();
    release();
  });
}
