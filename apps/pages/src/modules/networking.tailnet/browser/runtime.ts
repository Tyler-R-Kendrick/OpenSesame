import {
  TAILSCALE_BROWSER_NODE_PURPOSE,
  TAILSCALE_BROWSER_PEER_PURPOSE,
  TAILSCALE_IDENTITY_HTTP_PURPOSE,
} from "@opensesame/app-core/lib/capabilities/catalog-optional-services.js";
import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { bindIdentityBrowserNodeFactory } from "@opensesame/app-core/lib/tailscale/browser-node-identity-port.js";
import { bindTailscaleBrowserNode } from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import artifacts from "../../../lib/capabilities/tailscale-artifacts.json";
import type { Activation } from "../../activation.js";
import type { BrowserNodePolicy } from "./browser-node-policy.js";
import { createBrowserNodeController } from "./controller.js";
import { MemoryIdentityBrowserNode } from "./identity-browser-node.js";
export function bindTailscaleBrowserRuntime(
  ctx: ApprovedCapabilityContext,
  activation: Activation,
): void {
  const lease = ctx.lease;
  const signal = lease.signal;
  const egress = ctx.egress;
  const decide = egress.decide;
  const disposed = activation.disposed;
  const unchanged = () =>
    ctx.lease === lease &&
    lease.signal === signal &&
    ctx.egress === egress &&
    egress.decide === decide &&
    activation.disposed === disposed;
  const assertCurrent = () => {
    if (
      !unchanged() ||
      signal.aborted ||
      disposed.call(activation) ||
      !unchanged() ||
      signal.aborted
    )
      throw new Error("Enable Networking to connect a browser node.");
  };
  const policy: BrowserNodePolicy = {
    assertCurrent,
    approve: (href, method) => {
      assertCurrent();
      const url = new URL(href);
      if (method === "CONNECT") {
        if (!["wss:", "ws:"].includes(url.protocol)) return false;
        url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      } else if (!["https:", "http:"].includes(url.protocol)) return false;
      return decide.call(egress, url, {
        capability: "networking.tailnet",
        purpose: TAILSCALE_BROWSER_NODE_PURPOSE,
      }).ok;
    },
    approvePeer: (href) => {
      assertCurrent();
      return decide.call(egress, href, {
        capability: "networking.tailnet",
        purpose: TAILSCALE_BROWSER_PEER_PURPOSE,
        class: "peer-or-local-network",
      }).ok;
    },
  };
  const node = createBrowserNodeController(policy);
  const assetBase = new URL(import.meta.env.BASE_URL, location.origin);
  const releaseIdentity = bindIdentityBrowserNodeFactory(
    (owner) =>
      new MemoryIdentityBrowserNode(
        owner,
        {
          ...policy,
          approveNative: (href, method) => {
            assertCurrent();
            const decision = decide.call(egress, href, {
              capability: "networking.tailnet",
              purpose: TAILSCALE_IDENTITY_HTTP_PURPOSE,
            });
            assertCurrent();
            return method !== "CONNECT" && decision.ok;
          },
        },
        {
          runtime: new URL(artifacts.assets.runtime, assetBase).href,
          wasm: new URL(artifacts.assets.wasm, assetBase).href,
          nativeHTTP: new URL(artifacts.assets.nativeHTTP, assetBase).href,
        },
      ),
  );
  const release = bindTailscaleBrowserNode(node);
  const releaseLock = vaultStore.onLock(() => node.stop());
  const onAbort = () => {
    node.stop();
    releaseIdentity();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  activation.onDispose(() => {
    signal.removeEventListener("abort", onAbort);
    node.stop();
    releaseIdentity();
    releaseLock();
    release();
  });
}
